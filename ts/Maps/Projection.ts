/* *
 *
 *  (c) 2021 Torstein Honsi
 *
 *  License: www.highcharts.com/license
 *
 *  !!!!!!! SOURCE GETS TRANSPILED BY TYPESCRIPT. EDIT TS FILE ONLY. !!!!!!!
 *
 * */

'use strict';

import type {
    GeoJSONGeometryMultiPoint
} from './GeoJSON';
import type {
    LonLatArray,
    MapBounds,
    ProjectedXYArray
} from './MapViewOptions';
import type { ProjectionDefinition, Projector } from './ProjectionDefinition';
import type {
    ProjectionOptions,
    ProjectionRotationOption
} from './ProjectionOptions';
import type SVGPath from '../Core/Renderer/SVG/SVGPath';
import registry from './Projections/ProjectionRegistry.js';
import U from '../Core/Utilities.js';
const { clamp, erase } = U;


const deg2rad = Math.PI * 2 / 360;
// Safe padding on either side of the antimeridian to avoid points being
// projected to the wrong side of the plane
const floatCorrection = 0.000001;

// Keep longitude within -180 and 180. This is faster than using the modulo
// operator, and preserves the distinction between -180 and 180.
const wrapLon = (lon: number): number => {
    // Replacing the if's with while would increase the range, but make it prone
    // to crashes on bad data
    if (lon < -180) {
        lon += 360;
    }
    if (lon > 180) {
        lon -= 360;
    }
    return lon;
};

export default class Projection {

    public bounds: MapBounds|undefined;
    public options: ProjectionOptions;
    // Whether the chart has points, lines or polygons given as coordinates
    // with positive up, as opposed to paths in the SVG plane with positive
    // down.
    public hasCoordinates: boolean = false;
    // Whether the chart has true projection as opposed to pre-projected geojson
    // as in the legacy map collection.
    public hasGeoProjection: boolean = false;
    public rotator: Projector|undefined;
    public def: ProjectionDefinition|undefined;

    public static registry = registry;

    // Add a projection definition to the registry, accessible by its `name`.
    public static add(
        name: string,
        definition: typeof ProjectionDefinition
    ): void {
        Projection.registry[name] = definition;
    }

    // Calculate the great circle between two given coordinates
    public static greatCircle(
        point1: LonLatArray,
        point2: LonLatArray,
        inclusive?: boolean
    ): LonLatArray[] {
        const { atan2, cos, sin, sqrt } = Math;
        const lat1 = point1[1] * deg2rad;
        const lon1 = point1[0] * deg2rad;
        const lat2 = point2[1] * deg2rad;
        const lon2 = point2[0] * deg2rad;

        const deltaLat = lat2 - lat1;
        const deltaLng = lon2 - lon1;

        const calcA = sin(deltaLat / 2) * sin(deltaLat / 2) +
            cos(lat1) * cos(lat2) * sin(deltaLng / 2) * sin(deltaLng / 2);
        const calcB = 2 * atan2(sqrt(calcA), sqrt(1 - calcA));

        const distance = calcB * 6371e3; // in meters
        const jumps = Math.round(distance / 500000); // 500 km each jump

        const lineString: LonLatArray[] = [];

        if (inclusive) {
            lineString.push(point1);
        }

        if (jumps > 1) {
            const step = 1 / jumps;

            for (
                let fraction = step;
                fraction < 0.999; // Account for float errors
                fraction += step
            ) {
                const A = sin((1 - fraction) * calcB) / sin(calcB);
                const B = sin(fraction * calcB) / sin(calcB);

                const x = A * cos(lat1) * cos(lon1) + B * cos(lat2) * cos(lon2);
                const y = A * cos(lat1) * sin(lon1) + B * cos(lat2) * sin(lon2);
                const z = A * sin(lat1) + B * sin(lat2);

                const lat3 = atan2(z, sqrt(x * x + y * y));
                const lon3 = atan2(y, x);
                lineString.push([lon3 / deg2rad, lat3 / deg2rad]);
            }

        }

        if (inclusive) {
            lineString.push(point2);
        }

        return lineString;
    }

    public static insertGreatCircles(
        poly: LonLatArray[]
    ): void {
        let i = poly.length - 1;
        while (i--) {

            // Distance in degrees, either in lon or lat. Avoid heavy
            // calculation of true distance.
            const roughDistance = Math.max(
                Math.abs(poly[i][0] - poly[i + 1][0]),
                Math.abs(poly[i][1] - poly[i + 1][1])
            );
            if (roughDistance > 10) {
                const greatCircle = Projection.greatCircle(
                    poly[i],
                    poly[i + 1]
                );
                if (greatCircle.length) {
                    poly.splice(i + 1, 0, ...greatCircle);
                }
            }
        }
    }

    public static toString(
        options?: DeepPartial<ProjectionOptions>
    ): string|undefined {
        const {
            name,
            rotation
        } = options || {};

        return [name, rotation && rotation.join(',')].join(';');
    }

    public constructor(options: ProjectionOptions = {}) {
        this.options = options;
        const { name, projectedBounds, rotation } = options;

        this.rotator = rotation ? this.getRotator(rotation) : void 0;

        const ProjectionDefinition = name ? Projection.registry[name] : void 0;
        if (ProjectionDefinition) {
            this.def = new ProjectionDefinition(options);
        }
        const { def, rotator } = this;

        if (def) {
            this.maxLatitude = def.maxLatitude || 90;
            this.hasGeoProjection = true;
        }

        if (rotator && def) {
            this.forward = (lonLat): LonLatArray =>
                def.forward(rotator.forward(lonLat));
            this.inverse = (xy): ProjectedXYArray =>
                rotator.inverse(def.inverse(xy));
        } else if (def) {
            this.forward = (lonLat): LonLatArray => def.forward(lonLat);
            this.inverse = (xy): ProjectedXYArray => def.inverse(xy);
        } else if (rotator) {
            this.forward = rotator.forward;
            this.inverse = rotator.inverse;
        }

        // Projected bounds/clipping
        this.bounds = projectedBounds === 'world' ?
            def && def.bounds :
            projectedBounds;
    }

    public lineIntersectsBounds(line: ProjectedXYArray[]): ProjectedXYArray {
        const { x1, x2, y1, y2 } = this.bounds || {};

        const getIntersect = (
            line: ProjectedXYArray[],
            dim: 0|1,
            val?: number
        ): ProjectedXYArray|undefined => {
            const [p1, p2] = line,
                otherDim = dim ? 0 : 1;
            // Check if points are on either side of the line
            if (typeof val === 'number' && p1[dim] >= val !== p2[dim] >= val) {
                const fraction = ((val - p1[dim]) / (p2[dim] - p1[dim])),
                    crossingVal = p1[otherDim] +
                        fraction * (p2[otherDim] - p1[otherDim]);
                return dim ? [crossingVal, val] : [val, crossingVal];
            }
        };

        let intersection: ProjectedXYArray|undefined,
            ret = line[0];

        if ((intersection = getIntersect(line, 0, x1))) {
            ret = intersection;

            // Assuming line[1] was originally outside, replace it with the
            // intersection point so that the horizontal intersection will
            // be correct.
            line[1] = intersection;
        } else if ((intersection = getIntersect(line, 0, x2))) {
            ret = intersection;
            line[1] = intersection;
        }

        if ((intersection = getIntersect(line, 1, y1))) {
            ret = intersection;
        } else if ((intersection = getIntersect(line, 1, y2))) {
            ret = intersection;
        }

        return ret;
    }

    // Get the intermediate points along the perimeter of the bounds, in
    // practice the corners
    public getBoundsPerimeter(
        p1: ProjectedXYArray,
        p2: ProjectedXYArray
    ): ProjectedXYArray[] {
        const corners: ProjectedXYArray[] = [];

        // If they're on the same side, no interpolation
        if (p1[0] === p2[0] || p1[1] === p2[1]) {
            return corners;
        }

        let addCorner = false;

        if (this.bounds) {
            const { x1, x2, y1, y2 } = this.bounds,
                sides = [x1, y2, x2, y1, x1, y2, x2];
            sides.forEach((val, side): void => {
                const dim = side % 2;
                if (addCorner) {
                    corners.push(
                        dim === 0 ?
                            [val, sides[side - 1]] :
                            [sides[side - 1], val]
                    );
                }
                if (Math.abs(p1[dim] - val) < 0.5) {
                    addCorner = true;
                }
                if (Math.abs(p2[dim] - val) < 0.5) {
                    addCorner = false;
                }
            });
        }
        // Going the long way around the perimeter, try the other way around
        if (corners.length > 2) {
            return this.getBoundsPerimeter(p2, p1);
        }

        return corners;
    }

    /*
     * Take the rotation options and return the appropriate projection functions
     */
    public getRotator(rotation: ProjectionRotationOption): Projector|undefined {
        const deltaLambda = rotation[0] * deg2rad,
            deltaPhi = (rotation[1] || 0) * deg2rad,
            deltaGamma = (rotation[2] || 0) * deg2rad;

        const cosDeltaPhi = Math.cos(deltaPhi),
            sinDeltaPhi = Math.sin(deltaPhi),
            cosDeltaGamma = Math.cos(deltaGamma),
            sinDeltaGamma = Math.sin(deltaGamma);

        if (deltaLambda === 0 && deltaPhi === 0 && deltaGamma === 0) {
            // Don't waste processing time
            return;
        }

        return {
            forward: (lonLat): [number, number] => {
                // Lambda (lon) rotation
                const lon = lonLat[0] * deg2rad + deltaLambda;

                // Phi (lat) and gamma rotation
                const lat = lonLat[1] * deg2rad,
                    cosLat = Math.cos(lat),
                    x = Math.cos(lon) * cosLat,
                    y = Math.sin(lon) * cosLat,
                    sinLat = Math.sin(lat),
                    k = sinLat * cosDeltaPhi + x * sinDeltaPhi;
                return [
                    Math.atan2(
                        y * cosDeltaGamma - k * sinDeltaGamma,
                        x * cosDeltaPhi - sinLat * sinDeltaPhi
                    ) / deg2rad,
                    Math.asin(k * cosDeltaGamma + y * sinDeltaGamma) / deg2rad
                ];
            },

            inverse: (rLonLat): [number, number] => {
                // Lambda (lon) unrotation
                const lon = rLonLat[0] * deg2rad;

                // Phi (lat) and gamma unrotation
                const lat = rLonLat[1] * deg2rad,
                    cosLat = Math.cos(lat),
                    x = Math.cos(lon) * cosLat,
                    y = Math.sin(lon) * cosLat,
                    sinLat = Math.sin(lat),
                    k = sinLat * cosDeltaGamma - y * sinDeltaGamma;

                return [
                    (
                        Math.atan2(
                            y * cosDeltaGamma + sinLat * sinDeltaGamma,
                            x * cosDeltaPhi + k * sinDeltaPhi
                        ) - deltaLambda
                    ) / deg2rad,
                    Math.asin(k * cosDeltaPhi - x * sinDeltaPhi) / deg2rad
                ];

            }
        };

    }

    // Project a lonlat coordinate position to xy. Dynamically overridden when
    // projection is set.
    public forward(lonLat: LonLatArray): ProjectedXYArray {
        return lonLat;
    }

    // Unproject an xy chart coordinate position to lonlat. Dynamically
    // overridden when projection is set.
    public inverse(xy: ProjectedXYArray): LonLatArray {
        return xy;
    }

    public maxLatitude = 90;

    private cutOnAntimeridian(
        poly: LonLatArray[],
        isPolygon: boolean
    ): LonLatArray[][] {
        const antimeridian = 180;
        const intersections: {
            i: number;
            lat: number;
            direction: (-1|1);
            previousLonLat: LonLatArray;
            lonLat: LonLatArray;
        }[] = [];
        const polygons: LonLatArray[][] = [poly];

        poly.forEach((lonLat, i): void => {
            let previousLonLat = poly[i - 1];
            if (!i) {
                if (!isPolygon) {
                    return;
                }
                // Else, wrap to beginning
                previousLonLat = poly[poly.length - 1];
            }
            const lon1 = previousLonLat[0],
                lon2 = lonLat[0];

            if (
                // Both points, after rotating for antimeridian, are on the far
                // side of the Earth
                (lon1 < -90 || lon1 > 90) &&
                (lon2 < -90 || lon2 > 90) &&
                // ... and on either side of the plane
                (lon1 > 0) !== (lon2 > 0)
            ) {

                // Interpolate to the intersection latitude
                const fraction = clamp(
                        (antimeridian - (lon1 + 360) % 360) /
                            ((lon2 + 360) % 360 - (lon1 + 360) % 360),
                        0,
                        1
                    ),
                    lat = (
                        previousLonLat[1] +
                        fraction * (lonLat[1] - previousLonLat[1])
                    );

                intersections.push({
                    i,
                    lat,
                    direction: lon1 < 0 ? 1 : -1,
                    previousLonLat,
                    lonLat
                });
            }
        });

        let polarIntersection;
        if (intersections.length) {
            if (isPolygon) {

                // Simplified use of the even-odd rule, if there is an odd
                // amount of intersections between the polygon and the
                // antimeridian, the pole is inside the polygon. Applies
                // primarily to Antarctica.
                if (intersections.length % 2 === 1) {
                    polarIntersection = intersections.slice().sort(
                        (a, b): number => Math.abs(b.lat) - Math.abs(a.lat))[0];

                    erase(intersections, polarIntersection);
                }


                // Pull out slices of the polygon that is on the opposite side
                // of the antimeridian compared to the starting point
                let i = intersections.length - 2;
                while (i >= 0) {
                    const index = intersections[i].i;
                    const lonPlus = wrapLon(
                        antimeridian +
                        intersections[i].direction * floatCorrection
                    );
                    const lonMinus = wrapLon(
                        antimeridian -
                        intersections[i].direction * floatCorrection
                    );
                    const slice = poly.splice(
                        index,
                        intersections[i + 1].i - index,
                        // Add interpolated points close to the cut
                        ...Projection.greatCircle(
                            [lonPlus, intersections[i].lat],
                            [lonPlus, intersections[i + 1].lat],
                            true
                        )
                    );

                    // Add interpolated points close to the cut
                    slice.push(
                        ...Projection.greatCircle(
                            [lonMinus, intersections[i + 1].lat],
                            [lonMinus, intersections[i].lat],
                            true
                        )
                    );

                    polygons.push(slice);

                    i -= 2;
                }

                // Insert dummy points close to the pole
                if (polarIntersection) {
                    for (let i = 0; i < polygons.length; i++) {
                        const poly = polygons[i];
                        const indexOf = poly.indexOf(polarIntersection.lonLat);
                        if (indexOf > -1) {
                            const polarLatitude =
                                (polarIntersection.lat < 0 ? -1 : 1) *
                                this.maxLatitude;
                            const lon1 = wrapLon(
                                antimeridian +
                                polarIntersection.direction * floatCorrection
                            );
                            const lon2 = wrapLon(
                                antimeridian -
                                polarIntersection.direction * floatCorrection
                            );

                            const polarSegment = Projection.greatCircle(
                                [lon1, polarIntersection.lat],
                                [lon1, polarLatitude],
                                true
                            ).concat(Projection.greatCircle(
                                [lon2, polarLatitude],
                                [lon2, polarIntersection.lat],
                                true
                            ));

                            poly.splice(
                                indexOf,
                                0,
                                ...polarSegment
                            );
                            break;
                        }
                    }
                }

            // Map lines, not closed
            } else {
                let i = intersections.length;
                while (i--) {
                    const index = intersections[i].i;
                    const slice = poly.splice(
                        index,
                        poly.length,
                        // Add interpolated point close to the cut
                        [
                            wrapLon(
                                antimeridian +
                                intersections[i].direction * floatCorrection
                            ),
                            intersections[i].lat
                        ]
                    );

                    // Add interpolated point close to the cut
                    slice.unshift([
                        wrapLon(
                            antimeridian -
                            intersections[i].direction * floatCorrection
                        ),
                        intersections[i].lat
                    ]);
                    polygons.push(slice);
                }
            }
        }

        return polygons;
    }


    // Take a GeoJSON geometry and return a translated SVGPath
    public path(geometry: GeoJSONGeometryMultiPoint): SVGPath {

        const { def, rotator } = this;
        const antimeridian = 180;

        const path: SVGPath = [];
        const isPolygon = geometry.type === 'Polygon' ||
            geometry.type === 'MultiPolygon';

        // @todo: It doesn't really have to do with whether north is
        // positive. It depends on whether the coordinates are
        // pre-projected.
        const hasGeoProjection = this.hasGeoProjection;

        // @todo better test for when to do this (use clipAngle = 90?)
        const projectingToPlane = this.options.name !== 'Orthographic';
        // We need to rotate in a separate step before applying antimeridian
        // clipping
        const preclip = projectingToPlane ? rotator : void 0;
        const postclip = projectingToPlane ? (def || this) : this;

        const addToPath = (
            polygon: LonLatArray[]
        ): void => {

            // Create a copy of the original coordinates. The copy applies a
            // correction of points close to the antimeridian in order to
            // prevent the points to be projected to the wrong side of the
            // plane. Float errors in topojson or in the projection may cause
            // that.
            const poly = polygon.map((lonLat): LonLatArray => {
                if (projectingToPlane) {

                    if (preclip) {
                        lonLat = preclip.forward(lonLat);
                    }
                    let lon = lonLat[0];
                    if (Math.abs(lon - antimeridian) < floatCorrection) {
                        if (lon < antimeridian) {
                            lon = antimeridian - floatCorrection;
                        } else {
                            lon = antimeridian + floatCorrection;
                        }
                    }
                    lonLat = [lon, lonLat[1]];
                }
                return lonLat;
            });

            let polygons = [poly];


            if (hasGeoProjection) {

                // Insert great circles into long straight lines
                Projection.insertGreatCircles(poly);

                if (projectingToPlane) {
                    polygons = this.cutOnAntimeridian(poly, isPolygon);
                }
            }

            polygons.forEach((poly): void => {
                if (poly.length < 2) {
                    return;
                }

                let movedTo = false,
                    firstValidLonLat: LonLatArray|undefined,
                    lastValidLonLat: LonLatArray|undefined,
                    lastValidPoint: ProjectedXYArray|undefined,
                    lastInvalidPoint: ProjectedXYArray|undefined;

                const pushToPath = (point: [number, number]): void => {
                    if (!movedTo) {
                        path.push(['M', point[0], point[1]]);
                        movedTo = true;
                    } else {
                        path.push(['L', point[0], point[1]]);
                    }
                };

                for (let i = 0; i < poly.length; i++) {
                    const lonLat = poly[i],
                        point = postclip.forward(lonLat);

                    if (!point.outside) {

                        // In order to be able to interpolate if the first or
                        // last point is invalid (on the far side of the globe
                        // in an orthographic projection), we need to push the
                        // first valid point to the end of the polygon.
                        if (isPolygon && !firstValidLonLat) {
                            firstValidLonLat = lonLat;
                            // To get the intersection right we need the last
                            // invalid point too.
                            if (poly[i - 1]) {
                                poly.push(poly[i - 1]);
                            }
                            poly.push(lonLat);
                        }

                        // When entering the first valid point after a gap of
                        // invalid points, typically on the far side of the
                        // globe in an orthographic projection.
                        if (lastInvalidPoint) {
                            const intersection = (
                                this.bounds &&
                                projectingToPlane &&
                                this.lineIntersectsBounds(
                                    [point, lastInvalidPoint]
                                )
                            );

                            if (isPolygon && hasGeoProjection) {

                                if (intersection) {

                                    if (lastValidPoint) {
                                        // Push the intermediate points
                                        this.getBoundsPerimeter(
                                            lastValidPoint,
                                            intersection
                                        ).forEach(pushToPath);
                                    }

                                } else if (lastValidLonLat) {
                                    // Using a great circle is a simplificaction
                                    // that works for the orthographic
                                    // projection because the shapes are so
                                    // skewed at the edges. The correct path for
                                    // the edge would be to find the
                                    // intersection of the small circle (clip
                                    // angle), and render a small circle between
                                    // the two intersections.
                                    const greatCircle = Projection.greatCircle(
                                        lastValidLonLat,
                                        lonLat
                                    );
                                    greatCircle.forEach((lonLat): void => {
                                        pushToPath(postclip.forward(lonLat));
                                    });
                                }
                            // For lines, just jump over the gap
                            } else {
                                movedTo = false;
                            }
                            if (intersection) {
                                pushToPath(intersection);
                            }
                        }

                        pushToPath(point);

                        lastValidLonLat = lonLat;
                        lastValidPoint = point;
                        lastInvalidPoint = void 0;
                    } else {
                        if (lastValidPoint && !lastInvalidPoint) {
                            lastValidPoint = this.lineIntersectsBounds([
                                lastValidPoint, point
                            ]);
                            pushToPath(lastValidPoint);
                        }
                        lastInvalidPoint = point;
                    }
                }
            });
        };

        if (geometry.type === 'LineString') {
            addToPath(geometry.coordinates);

        } else if (geometry.type === 'MultiLineString') {
            geometry.coordinates.forEach((c): void => addToPath(c));

        } else if (geometry.type === 'Polygon') {
            geometry.coordinates.forEach((c): void => addToPath(c));
            if (path.length) {
                path.push(['Z']);
            }

        } else if (geometry.type === 'MultiPolygon') {
            geometry.coordinates.forEach((polygons): void => {
                polygons.forEach((c): void => addToPath(c));
            });
            if (path.length) {
                path.push(['Z']);
            }

        }

        return path;
    }
}
