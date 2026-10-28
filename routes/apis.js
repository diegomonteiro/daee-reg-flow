var express = require('express');
var router  = express.Router();
var turf    = require('@turf/turf');
var debug   = require('debug')('daee-reg-flow:api');

var _ = require('lodash');

const regflow = require('../models/regflow');
const calculationMemorial = require('../services/calculation-memorial');
const numericFormat = require('../public/javascripts/numbers');

require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });

var municipios_json  = require('../public/layers/municipios.json');
var ottobacias_json  = require('../public/layers/ottobacias.json');
var ottotrechos_json = require('../public/layers/ottotrechos.json');
var isolines_json    = require('../public/layers/rain_isoline.json');
var rau_json         = require('../public/layers/rau.json');
var rxyz_json        = require('../public/layers/rxyz.json');
var limite_sp_json   = require('../public/layers/limite_estadual_sp.json');

const coordinateCache = new Map();
const coordinateRequests = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000;
const ottotrechosByBasin = _.groupBy(ottotrechos_json.features, 'properties.COBACIA');
const ottobaciasByCode = _.keyBy(ottobacias_json.features, 'properties.COBACIA');
const upstreamCodesByJusante = {};
ottotrechos_json.features.forEach(feature => {
    const code = feature && feature.properties && feature.properties.COBACIA;
    const jus = feature && feature.properties && feature.properties.COBACIAJUS;
    if (!code || !jus || String(code).startsWith('_VIRTUAL') || !ottobaciasByCode[code]) return;
    if (!upstreamCodesByJusante[jus]) upstreamCodesByJusante[jus] = [];
    if (!upstreamCodesByJusante[jus].includes(code)) upstreamCodesByJusante[jus].push(code);
});

function collectUpstreamBasinCodes(startCode) {
    if (!startCode) return [];
    const visited = new Set([String(startCode)]);
    const queue = [String(startCode)];
    const upstreamCodes = [];
    while (queue.length > 0) {
        const current = queue.shift();
        const children = upstreamCodesByJusante[current] || [];
        for (const child of children) {
            if (!visited.has(child)) {
                visited.add(child);
                upstreamCodes.push(child);
                queue.push(child);
            }
        }
    }
    return upstreamCodes;
}

const streamBounds = ottotrechos_json.features.map(feature => ({ feature, bbox: turf.bbox(feature) }));

function getIntersectingStreams(geometry) {
    const bounds = turf.bbox(geometry);
    return streamBounds
        .filter(item => boundsIntersect(bounds, item.bbox) && turf.booleanIntersects(geometry, item.feature))
        .map(item => item.feature);
}

const basinBounds = ottobacias_json.features.map(feature => ({ feature, bbox: turf.bbox(feature) }));
const isohyetCatalog = [{ id: 'historical-1980', name: 'Isoietas históricas (pré-1980)', description: 'Camada padrão usada pela regionalização original do DAEE.' }];
const isohyetLayers = { 'historical-1980': isolines_json };
const rainPropertyNames = ['ID', 'rain', 'precipitation', 'precipitacao', 'PRECIPITACAO', 'P', 'mm'];

function isPointInBounds(lon, lat, bbox) {
    return lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}

function findContainingFeature(index, point, lon, lat) {
    const candidate = _.find(index, item =>
        isPointInBounds(lon, lat, item.bbox) && turf.booleanPointInPolygon(point, item.feature)
    );
    return candidate ? candidate.feature : null;
}

function boundsIntersect(first, second) {
    return first[0] <= second[2] && first[2] >= second[0] && first[1] <= second[3] && first[3] >= second[1];
}

function getIntersectingBasins(geometry, drawnAreaKm2) {
    const geometryBounds = turf.bbox(geometry);
    return basinBounds.reduce((matches, item) => {
        if (!boundsIntersect(geometryBounds, item.bbox)) return matches;
        let intersection;
        try {
            if (!turf.booleanIntersects(geometry, item.feature)) return matches;
            intersection = turf.intersect(geometry, item.feature);
        } catch (error) {
            return matches;
        }
        if (!intersection) return matches;
        const overlapAreaKm2 = turf.area(intersection) / 1000000;
        if (!Number.isFinite(overlapAreaKm2) || overlapAreaKm2 < 0.000001) return matches;
        const basinAreaKm2 = turf.area(item.feature) / 1000000;
        intersection.properties = {
            COBACIA: item.feature.properties.COBACIA,
            overlap_area_km2: overlapAreaKm2,
            drawn_area_percent: Math.min(overlapAreaKm2 / drawnAreaKm2 * 100, 100),
            basin_area_percent: basinAreaKm2 > 0 ? Math.min(overlapAreaKm2 / basinAreaKm2 * 100, 100) : null
        };
        matches.push(intersection);
        return matches;
    }, []).sort((first, second) => second.properties.drawn_area_percent - first.properties.drawn_area_percent);
}

function limitCoordinateRequests(req, res, next) {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const current = coordinateRequests.get(key);
    if (!current || now - current.startedAt >= 60 * 1000) {
        if (coordinateRequests.size > 1000) {
            for (const [entryKey, entry] of coordinateRequests.entries()) {
                if (now - entry.startedAt >= 60 * 1000) coordinateRequests.delete(entryKey);
            }
        }
        coordinateRequests.set(key, { startedAt: now, count: 1 });
        return next();
    }
    current.count += 1;
    if (current.count > 30) {
        res.set('Retry-After', '60');
        return res.status(429).json({ error: 'Too many calculations. Please wait and try again.' });
    }
    next();
}

function countCoordinates(coordinates) {
    if (!Array.isArray(coordinates)) return 0;
    if (coordinates.length >= 2 && coordinates.every(Number.isFinite)) return 1;
    return coordinates.reduce((total, item) => total + countCoordinates(item), 0);
}

function validateBasinGeometry(input, options = {}) {
    if (!input || input.type !== 'Feature' || !input.geometry || !['Polygon', 'MultiPolygon'].includes(input.geometry.type)) {
        const error = new Error('A valid Polygon or MultiPolygon GeoJSON feature is required');
        error.status = 400;
        throw error;
    }
    if (options.allowOfficialBasin && input.properties && input.properties.COBACIA) {
        const official = ottobaciasByCode[String(input.properties.COBACIA)];
        if (official && _.isEqual(input.geometry.coordinates, official.geometry.coordinates)) {
            return { geometry: official, areaKm2: turf.area(official) / 1000000 };
        }
        if (official && (input.properties.is_upstream_subbasin || input.properties.is_upstream_network)) {
            const areaKm2 = turf.area(input) / 1000000;
            if (Number.isFinite(areaKm2) && areaKm2 > 0) {
                return { geometry: input, areaKm2 };
            }
        }
    }
    if (countCoordinates(input.geometry.coordinates) > 5000) {
        const error = new Error('The geometry exceeds the limit of 5000 vertices');
        error.status = 413;
        throw error;
    }

    const geometry = turf.cleanCoords(input);
    const areaKm2 = turf.area(geometry) / 1000000;
    if (!Number.isFinite(areaKm2) || areaKm2 <= 0) {
        const error = new Error('The geometry must have a valid area');
        error.status = 400;
        throw error;
    }
    if (turf.kinks(geometry).features.length > 0) {
        const error = new Error('The geometry cannot contain self-intersections');
        error.status = 422;
        throw error;
    }
    let isWithinState = true;
    turf.flattenEach(geometry, polygon => {
        const checkState = state => options.allowPartialStateOverlap ? turf.booleanIntersects(polygon, state) : turf.booleanWithin(polygon, state);
        if (!limite_sp_json.features.some(checkState)) isWithinState = false;
    });
    if (!isWithinState) {
        const error = new Error('The geometry must be entirely within the State of São Paulo');
        error.status = 400;
        throw error;
    }
    return { geometry, areaKm2 };
}

function validateRainfallLayer(input) {
    const collection = input && input.type === 'FeatureCollection' ? input : input && input.type === 'Feature' ? turf.featureCollection([input]) : null;
    if (!collection || !Array.isArray(collection.features) || collection.features.length === 0) {
        const error = new Error('A non-empty GeoJSON FeatureCollection is required for each isohyet layer');
        error.status = 400;
        throw error;
    }
    const coordinateTotal = collection.features.reduce((total, feature) => total + countCoordinates(feature && feature.geometry && feature.geometry.coordinates), 0);
    if (coordinateTotal > 750000) {
        const error = new Error('A camada de isoietas excede o limite de 750 mil coordenadas. Simplifique a geometria antes do envio.');
        error.status = 422;
        throw error;
    }
    const normalized = collection.features.map((feature, index) => {
        if (!feature || feature.type !== 'Feature' || !feature.geometry || !['Polygon', 'MultiPolygon'].includes(feature.geometry.type)) {
            const error = new Error(`Isohyet feature ${index + 1} must be a Polygon or MultiPolygon`);
            error.status = 400;
            throw error;
        }
        const property = rainPropertyNames.find(name => Number.isFinite(Number(feature.properties && feature.properties[name])));
        const rainfall = property ? Number(feature.properties[property]) : NaN;
        if (!Number.isFinite(rainfall) || rainfall <= 0 || rainfall > 10000) {
            const error = new Error(`Isohyet feature ${index + 1} must contain a positive rainfall value in ID, rain, precipitation, precipitacao, P or mm`);
            error.status = 422;
            throw error;
        }
        const cleaned = turf.cleanCoords(feature);
        cleaned.properties = { ...(feature.properties || {}), ID: rainfall };
        return cleaned;
    });
    return turf.featureCollection(normalized);
}

function calculateFlows(regionCoefs, rainfall, areaKm2) {
    if ([regionCoefs.rau.avg_a, regionCoefs.rau.avg_b, regionCoefs.rau.coef_a, regionCoefs.rau.coef_b, regionCoefs.rxyz.coef_c, rainfall.avg_areas].some(value => !Number.isFinite(value))) {
        const error = new Error('The isohyet layer does not provide valid coverage for the selected basin');
        error.status = 422;
        throw error;
    }
    const averageDischarge = regflow.calculateAvgFlowRateLongPeriod(regionCoefs.rau.avg_a, regionCoefs.rau.avg_b, rainfall.avg_areas, areaKm2);
    const q95Values = [];
    const q710Values = [];
    _.each(regionCoefs.rau.bands, region => {
        const properties = region.properties;
        q95Values.push({ value: regflow.calculateQ95(properties.region, averageDischarge), weight: properties.partial_area });
        q710Values.push({ value: regflow.calculateQ7T(regionCoefs.rxyz.coef_c, properties.region, 0, properties.coef_a, properties.coef_b, averageDischarge), weight: properties.partial_area });
    });
    return { avg_discharge: averageDischarge, q95: regflow.calculateAvgByWeight(q95Values), q710: regflow.calculateAvgByWeight(q710Values) };
}

function getLineEndpoints(feature) {
    const coordinates = feature && feature.geometry && feature.geometry.coordinates;
    if (!Array.isArray(coordinates)) return null;
    const lines = feature.geometry.type === 'LineString' ? [coordinates] : feature.geometry.type === 'MultiLineString' ? coordinates : [];
    const validLines = lines.filter(line => Array.isArray(line) && line.length > 0);
    if (!validLines.length) return null;
    return { first: validLines[0][0], last: validLines[validLines.length - 1][validLines[validLines.length - 1].length - 1] };
}

function isFirstEndpointUpstreamByTopology(segment, endpoints) {
    const downstreamBasinCode = segment && segment.properties && segment.properties.COBACIAJUS;
    const downstreamSegments = downstreamBasinCode ? ottotrechosByBasin[downstreamBasinCode] : null;
    if (Array.isArray(downstreamSegments) && downstreamSegments.length > 0) {
        const jusCoords = downstreamSegments[0].geometry && downstreamSegments[0].geometry.coordinates;
        const jusLineCoords = downstreamSegments[0].geometry.type === 'LineString' ? jusCoords : Array.isArray(jusCoords) ? jusCoords[0] : null;
        if (Array.isArray(jusLineCoords) && jusLineCoords.length >= 2) {
            const jusLine = turf.lineString(jusLineCoords);
            const distFirst = turf.pointToLineDistance(turf.point(endpoints.first), jusLine, { units: 'kilometers' });
            const distLast = turf.pointToLineDistance(turf.point(endpoints.last), jusLine, { units: 'kilometers' });
            if (Math.abs(distFirst - distLast) > 1e-6) {
                return distFirst > distLast;
            }
        }
    }
    return true;
}

async function enrichStreamSegments(segments, includeElevation = true) {
    return Promise.all((segments || []).map(async segment => {
        const endpoints = getLineEndpoints(segment);
        if (!endpoints) return segment;
        const [firstElevation, lastElevation] = await Promise.all([
            includeElevation ? regflow.getElevationByCoords(endpoints.first[1], endpoints.first[0]) : null,
            includeElevation ? regflow.getElevationByCoords(endpoints.last[1], endpoints.last[0]) : null
        ]);
        const firstMeters = firstElevation && Number.isFinite(firstElevation.max) ? firstElevation.max : null;
        const lastMeters = lastElevation && Number.isFinite(lastElevation.max) ? lastElevation.max : null;
        const first = { coordinates: endpoints.first, elevation_m: firstMeters };
        const last = { coordinates: endpoints.last, elevation_m: lastMeters };
        const hasElevation = firstMeters !== null && lastMeters !== null;
        const firstIsUpstream = hasElevation && firstMeters !== lastMeters
            ? firstMeters > lastMeters
            : isFirstEndpointUpstreamByTopology(segment, endpoints);
        const upstream = firstIsUpstream ? first : last;
        const downstream = firstIsUpstream ? last : first;
        return { ...segment, properties: { ...segment.properties, stream_endpoints: { first, last, upstream, downstream, elevation_source: hasElevation ? 'mapbox-terrain-v2' : 'topology' } } };
    }));
}

function streamLengthInPolygon(line, poly, samples = 40) {
    const totalLen = turf.length(line, { units: 'kilometers' });
    if (!Number.isFinite(totalLen) || totalLen <= 1e-6) return 0;
    let inside = 0;
    for (let i = 0; i <= samples; i++) {
        const pt = turf.along(line, (totalLen * i) / samples, { units: 'kilometers' });
        if (turf.booleanPointInPolygon(pt, poly)) inside++;
    }
    return (inside / (samples + 1)) * totalLen;
}

function splitBasinUpstreamByPoint(ottobacia, streamSegments, lat, lon) {
    const fullAreaKm2 = turf.area(ottobacia) / 1000000;
    const primarySegment = Array.isArray(streamSegments) && streamSegments[0];
    if (!primarySegment || !primarySegment.geometry) {
        return { upstreamBasin: ottobacia, fullAreaKm2, upstreamAreaKm2: fullAreaKm2, areaProportion: 1, crossSection: null };
    }
    try {
        const clickedPt = turf.point([lon, lat]);
        const rawLines = primarySegment.geometry.type === 'LineString'
            ? [primarySegment.geometry.coordinates]
            : primarySegment.geometry.coordinates || [];
        const validLines = rawLines.filter(line => Array.isArray(line) && line.length >= 2);
        if (!validLines.length) {
            return { upstreamBasin: ottobacia, fullAreaKm2, upstreamAreaKm2: fullAreaKm2, areaProportion: 1, crossSection: null };
        }
        const endpoints = primarySegment.properties && primarySegment.properties.stream_endpoints;
        const upstreamCoord = endpoints && endpoints.upstream && endpoints.upstream.coordinates ? endpoints.upstream.coordinates : validLines[0][0];
        const rawCoords = validLines[0];
        const firstDistToUp = turf.distance(turf.point(rawCoords[0]), turf.point(upstreamCoord), { units: 'kilometers' });
        const lastDistToUp = turf.distance(turf.point(rawCoords[rawCoords.length - 1]), turf.point(upstreamCoord), { units: 'kilometers' });
        const orderedCoords = firstDistToUp <= lastDistToUp ? rawCoords : [...rawCoords].reverse();
        const streamLine = turf.lineString(orderedCoords);
        const upstreamPt = turf.point(orderedCoords[0]);
        const downstreamPt = turf.point(orderedCoords[orderedCoords.length - 1]);
        const snapped = turf.nearestPointOnLine(streamLine, clickedPt, { units: 'kilometers' });
        const upDistFromCut = turf.distance(upstreamPt, snapped, { units: 'kilometers' });
        const downDistFromCut = turf.distance(downstreamPt, snapped, { units: 'kilometers' });
        if (upDistFromCut <= 0.02 || downDistFromCut <= 0.02) {
            return { upstreamBasin: ottobacia, fullAreaKm2, upstreamAreaKm2: fullAreaKm2, areaProportion: 1, crossSection: null };
        }
        const [sx, sy] = snapped.geometry.coordinates;
        const cosLat = Math.cos(lat * Math.PI / 180) || 1;
        const bbox = turf.bbox(ottobacia);
        const diag = Math.hypot((bbox[2] - bbox[0]) * cosLat, bbox[3] - bbox[1]) * 2 || 1;
        const border = turf.polygonToLine(ottobacia);

        const totalStreamLen = turf.length(streamLine, { units: 'kilometers' });
        const snapLoc = Number.isFinite(snapped.properties && snapped.properties.location) ? snapped.properties.location : 0;
        const windowKm = Math.max(0.4, Math.min(2.0, totalStreamLen * 0.15));
        const pBefore = turf.along(streamLine, Math.max(0, snapLoc - windowKm), { units: 'kilometers' }).geometry.coordinates;
        const pAfter = turf.along(streamLine, Math.min(totalStreamLen, snapLoc + windowKm), { units: 'kilometers' }).geometry.coordinates;
        const tanDx = (pAfter[0] - pBefore[0]) * cosLat;
        const tanDy = pAfter[1] - pBefore[1];
        const tanLen = Math.hypot(tanDx, tanDy) || 1;
        const tanX = tanDx / tanLen;
        const tanY = tanDy / tanLen;
        const macroNx = -tanY;
        const macroNy = tanX;

        const evaluateCandidate = (dirX, dirY) => {
            const toCoord = s => [lon + (s * dirX) / cosLat, lat + s * dirY];
            const farLine = turf.lineString([toCoord(-diag), toCoord(diag)]);
            const streamIntersections = turf.lineIntersect(farLine, streamLine);
            if (!streamIntersections || !streamIntersections.features || !streamIntersections.features.length) return null;
            const streamHits = streamIntersections.features.map(f => {
                const [x, y] = f.geometry.coordinates;
                return { s: (x - lon) * cosLat * dirX + (y - lat) * dirY, coord: [x, y] };
            }).sort((a, b) => Math.abs(a.s) - Math.abs(b.s));
            const streamHit = streamHits[0];
            const sStream = streamHit.s;
            const sMinReq = Math.min(0, sStream);
            const sMaxReq = Math.max(0, sStream);

            const borderIntersections = turf.lineIntersect(farLine, border);
            const sVals = (borderIntersections && borderIntersections.features || []).map(f => {
                const [x, y] = f.geometry.coordinates;
                return { s: (x - lon) * cosLat * dirX + (y - lat) * dirY, coord: [x, y] };
            }).sort((a, b) => a.s - b.s);
            if (sVals.length < 2) return null;
            if (sVals.some(h => h.s > sMinReq + 1e-6 && h.s < sMaxReq - 1e-6)) return null;

            const negIdx = sVals.findLastIndex(h => h.s <= sMinReq + 1e-7);
            const posIdx = sVals.findIndex((h, idx) => idx > negIdx && h.s >= sMaxReq - 1e-7 && (negIdx === -1 || h.s - sVals[negIdx].s > 1e-5));
            if (negIdx === -1 || posIdx === -1) return null;
            const negHit = sVals[negIdx];
            const posHit = sVals[posIdx];
            if (!negHit || !posHit || posHit.s - negHit.s <= 1e-6) return null;
            const midPt = turf.point(toCoord((negHit.s + posHit.s) / 2));
            if (!turf.booleanPointInPolygon(midPt, ottobacia)) return null;

            const chordKm = turf.distance(turf.point(negHit.coord), turf.point(posHit.coord), { units: 'kilometers' });
            const chordLine = turf.lineString([negHit.coord, posHit.coord]);
            const streamCrossings = Math.max(1, turf.lineIntersect(chordLine, streamLine).features.length);
            return { negHit, posHit, streamCoord: streamHit.coord, sStream, chordKm, streamCrossings, sVals, negIdx, posIdx, toCoord };
        };

        const rawUx = (lon - sx) * cosLat;
        const rawUy = lat - sy;
        const len = Math.hypot(rawUx, rawUy);
        const candidateDirs = [];
        if (len > 1e-4) {
            const dux = rawUx / len;
            const duy = rawUy / len;
            const dotTan = Math.abs(dux * tanX + duy * tanY);
            if (dotTan <= 0.6) candidateDirs.push({ ux: dux, uy: duy, penalty: 0 });
        }
        for (const deg of [0, -15, 15, -30, 30]) {
            const rad = (deg * Math.PI) / 180;
            const c = Math.cos(rad);
            const s = Math.sin(rad);
            candidateDirs.push({
                ux: macroNx * c - macroNy * s,
                uy: macroNx * s + macroNy * c,
                penalty: Math.abs(deg) * 0.02
            });
        }

        const validCandidates = candidateDirs
            .map(dir => {
                const evaluated = evaluateCandidate(dir.ux, dir.uy);
                if (!evaluated) return null;
                const cost = (evaluated.streamCrossings > 1 ? (evaluated.streamCrossings - 1) * 5 : 0) + evaluated.chordKm + dir.penalty;
                return { ...evaluated, cost };
            })
            .filter(Boolean)
            .sort((a, b) => a.cost - b.cost);

        if (!validCandidates.length) {
            return { upstreamBasin: ottobacia, fullAreaKm2, upstreamAreaKm2: fullAreaKm2, areaProportion: 1, crossSection: null };
        }

        const bestCandidate = validCandidates[0];
        const { negHit, posHit, streamCoord, sStream, sVals, negIdx, posIdx, toCoord } = bestCandidate;
        const [x0, y0] = streamCoord;
        const prevHit = negIdx > 0 ? sVals[negIdx - 1] : null;
        const nextHit = posIdx !== -1 && posIdx < sVals.length - 1 ? sVals[posIdx + 1] : null;
        const epsNeg = prevHit ? Math.min(0.00005, (negHit.s - prevHit.s) * 0.25) : 0.00005;
        const epsPos = nextHit ? Math.min(0.00005, (nextHit.s - posHit.s) * 0.25) : 0.00005;

        const sectionCoords = Math.abs(sStream) > 1e-5
            ? (sStream < 0 ? [negHit.coord, [x0, y0], [lon, lat], posHit.coord] : [negHit.coord, [lon, lat], [x0, y0], posHit.coord])
            : [negHit.coord, [x0, y0], posHit.coord];
        const crossSection = {
            line: turf.lineString(sectionCoords, { COBACIA: ottobacia.properties && ottobacia.properties.COBACIA }),
            stream_point: [x0, y0],
            clicked_point: [lon, lat],
            border_points: [negHit.coord, posHit.coord]
        };

        const chordExtended = turf.lineString([toCoord(negHit.s - epsNeg), toCoord(posHit.s + epsPos)]);
        const cutter = turf.buffer(chordExtended, 0.00005, { units: 'kilometers', steps: 4 });
        const diff = turf.difference(ottobacia, cutter);
        if (!diff) {
            return { upstreamBasin: ottobacia, fullAreaKm2, upstreamAreaKm2: fullAreaKm2, areaProportion: 1, crossSection: null };
        }
        const cutStreamPt = turf.nearestPointOnLine(streamLine, turf.point([x0, y0]), { units: 'kilometers' });
        const upstreamLine = turf.lineSlice(upstreamPt, cutStreamPt, streamLine);
        const downstreamLine = turf.lineSlice(cutStreamPt, downstreamPt, streamLine);

        const pieces = [];
        turf.flattenEach(diff, poly => {
            const area = turf.area(poly) / 1000000;
            if (!Number.isFinite(area) || area <= 1e-6) return;
            const upLen = streamLengthInPolygon(upstreamLine, poly);
            const downLen = streamLengthInPolygon(downstreamLine, poly);
            const hasUpPt = turf.booleanPointInPolygon(upstreamPt, poly);
            const hasDownPt = turf.booleanPointInPolygon(downstreamPt, poly);
            if ((upLen <= 1e-4 && !hasUpPt) || downLen > upLen) return;
            const score = (upLen - downLen) + (hasUpPt ? 1000 : 0) - (hasDownPt ? 1000 : 0);
            pieces.push({ poly, area, score });
        });
        if (!pieces.length) {
            return { upstreamBasin: ottobacia, fullAreaKm2, upstreamAreaKm2: fullAreaKm2, areaProportion: 1, crossSection: null };
        }
        pieces.sort((a, b) => b.score - a.score);
        const bestPiece = pieces[0];
        const upstreamAreaKm2 = Math.min(bestPiece.area, fullAreaKm2);
        const upstreamBasin = turf.multiPolygon(
            [bestPiece.poly.geometry.coordinates],
            { ...(ottobacia.properties || {}), is_upstream_subbasin: true }
        );
        return {
            upstreamBasin,
            fullAreaKm2,
            upstreamAreaKm2,
            areaProportion: fullAreaKm2 > 0 ? Math.min(upstreamAreaKm2 / fullAreaKm2, 1) : 1,
            crossSection
        };
    } catch (error) {
        return { upstreamBasin: ottobacia, fullAreaKm2, upstreamAreaKm2: fullAreaKm2, areaProportion: 1, crossSection: null };
    }
}

async function calculateGeometry(geometry, options = {}) {
    const areaKm2 = turf.area(geometry) / 1000000;
    const regionCoefs = regflow.getRegionsCoeficientsByGeometry(geometry, 1, { units: 'kilometers' }, 'area', options.rainfallLayer || isolines_json);
    const rainfall = { avg_areas: regionCoefs.isolines.avg_rain_areas, avg_points: regionCoefs.isolines.avg_rain_points, bands: regionCoefs.isolines.bands };
    const flows = calculateFlows(regionCoefs, rainfall, areaKm2);

    const center = turf.centroid(geometry).geometry.coordinates;
    const altitude = options.includeElevation === false ? null : await regflow.getElevationByCoords(center[1], center[0]);
    const streamSegments = await enrichStreamSegments(options.ottotrecho || (options.includeIntersectingStreams ? getIntersectingStreams(geometry) : []), options.includeElevation !== false);
    const intersectingBasins = options.includeBasinOverlaps ? getIntersectingBasins(geometry, areaKm2) : [];
    return {
        source: options.source || 'geometry',
        latitude: center[1],
        longitude: center[0],
        area_km2: areaKm2,
        altitude,
        rxyz: regionCoefs.rxyz,
        rau: regionCoefs.rau,
        isolines: rainfall,
        ottotrecho: streamSegments,
        ottobacia: geometry,
        intersecting_basins: intersectingBasins,
        avg_discharge: flows.avg_discharge,
        q95: flows.q95,
        q710: flows.q710,
        qmin: null
    };
}

function validateNumberParam(name, options = {}) {
    router.param(name, function(req, res, next, value) {
        const number = Number(value);
        if (!Number.isFinite(number) || (options.min !== undefined && number < options.min) || (options.max !== undefined && number > options.max)) {
            return res.status(400).json({ error: `Invalid parameter: ${name}` });
        }
        next();
    });
}

['qf', 'xt', 'a', 'b', 'd', 'qls_m3s', 'k', 'coef_a', 'coef_b', 'avg_rainfall', 'area_km2', 'c', 'val_a', 'val_b'].forEach(validateNumberParam);
validateNumberParam('lat', { min: -90, max: 90 });
validateNumberParam('lon', { min: -180, max: 180 });
validateNumberParam('time', { min: 0, max: 5 });
validateNumberParam('t', { min: 0, max: 5 });
validateNumberParam('dmonth', { min: 1, max: 12 });
validateNumberParam('months', { min: 1, max: 12 });

router.param('region', function(req, res, next, value) {
    if (!/^[a-u]$/i.test(value)) return res.status(400).json({ error: 'Invalid parameter: region' });
    next();
});


/**
 * List all Cities
 */
router.get('/municipios', function(req, res, next) { 
    res.status(200).send(municipios_json) 
});

/**
 * Find City by CodIbge
 */
router.get('/municipios/:cod_ibge', function(req,res,next){
    //res.status(200).send()
    var cities = _.filter(municipios_json.features, function(e){ 
        return e.properties.codarea == req.params["cod_ibge"]
    });

    if(cities.length > 0){
        res.status(200).json(cities)
    }
    else{
        res.status(200).json('not found')
    }
})

/**
 * Find Ottobacia by Cod
 */
router.get('/ottobacias/:cod', function(req,res,next){
    var ottobacias = _.filter(ottobacias_json.features, function(e){
        return e.properties.COBACIA == req.params['cod'];
    });

    if(ottobacias.length > 0){
        res.status(200).json(ottobacias)
    }else{
        res.status(200).json('not found')
    }
});

/**
 * Find Ottotrecho By Cod
 */
router.get('/ottotrechos/:cod', function(req,res,next){
    var ottotrechos = _.filter(ottotrechos_json.features, function(e){
        return e.properties.COBACIA == req.params['cod'];
    });

    if(ottotrechos.length > 0){
        res.status(200).json(ottotrechos);
    }else{

        res.status(200).json('not found')
    }
});

/**
 * Method to calculte critical duration using parameters
 */
router.get('/calculate_critical_duration/:qf/:xt/:a/:b/:qls_m3s', function(req,res,next){
    async function run(){
        var qf = parseFloat(req.params['qf']);
        var xt = parseFloat(req.params['xt']);
        var a  = parseFloat(req.params['a']);
        var b  = parseFloat(req.params['b']);
        var q  = parseFloat(req.params['qls_m3s']);

        var ret = (qf-(xt*a*q))/(2*xt*b*q);

        res.status(200).json({
            critical_duration: ret
        })
    }

    run().catch(next);
});

/**
 * Method to calculate volume regularization
 */
router.get('/calculate_volume_regularization/:qf/:xt/:a/:b/:d/:qls_m3s/:k', function(req,res,next){
    async function run(){
        var qf = parseFloat(req.params['qf']);
        var xt = parseFloat(req.params['xt']);
        var a  = parseFloat(req.params['a']);
        var b  = parseFloat(req.params['b']);
        var d  = parseFloat(req.params['d']);
        var q  = parseFloat(req.params['qls_m3s']);
        var k  = parseFloat(req.params['k']);

        var ret = (qf-xt*(a+b*d)*q)*k*d;

        res.status(200).json({
            vol: ret
        })
    };

    run().catch(next);
});

/**
 * Method to calculte max volume to regularization
 */
router.get('/calculate_max_volume_regularization/:qf/:region/:t/:a/:b/:qls_m3s/:months', function(req,res,next){
    async function run(){
        var qf = parseFloat(req.params['qf']);
        var region = req.params['region'];
        var time   = req.params['t'];
        
        var a  = parseFloat(req.params['a']);
        var b  = parseFloat(req.params['b']);
        var q  = parseFloat(req.params['qls_m3s']);
        var months  = parseInt(req.params['months']);

        debug('Qf=%s A=%s B=%s Qa=%s months=%s', qf, a, b, q, months);
        //var ret = (Math.pow(qf-(xt*a*q),2)/(4*xt*b*q))*k;
        var ret = regflow.calculateVolumeRegularization(qf,region,time,a,b,q,months);

        debug('Max=%s', ret);

        res.status(200).json({
            volume_m3: ret,
            volume_h3: ret/1000000,
            units: "m³"
        })
    } 
    
    run().catch(next);
});

/**
 * Method to calculate mean yearly discharge using coef a, coef b, avg rainfall and area km²
 */
router.get('/calculate_discharge_avg/:coef_a/:coef_b/:avg_rainfall/:area_km2', function(req,res,next){
    async function run(){
        var coef_a = parseFloat(req.params['coef_a']);
        var coef_b = parseFloat(req.params['coef_b']);
        var avg_rainfall = parseFloat(req.params['avg_rainfall']);
        var area_km2 = parseFloat(req.params['area_km2']);

        var ret = regflow.calculateAvgFlowRateLongPeriod(coef_a, coef_b, avg_rainfall, area_km2);

        debug('AVG.discharge => %s', ret);

        res.status(200).json({
            avg: ret,
            unit: "m³/s",
            params:{
                area_km2: area_km2,
                coef_a: coef_a,
                coef_b: coef_b,
                avg_year_rainfall: avg_rainfall
            }
        })
    }

    run().catch(next);
});

/**
 * Method to calculate minimal discharge
 * Region
 * Time
 * Coef A
 * Coef B
 * Months
 * Discharge
 */
router.get('/calculate_minimal_discharge/:region/:time/:a/:b/:dmonth/:qls_m3s', function(req,res,next){
    async function run(){
        var region = req.params['region'];
        var time   = req.params['time'];
        var xt      = regflow.getXTCoef(region,time);
        var dm      = parseInt(req.params['dmonth']);
        var qls_m3s = parseFloat(req.params['qls_m3s']);
        var a       = parseFloat(req.params['a']);
        var b       = parseFloat(req.params['b']);

        debug('XT=%s', xt);

        var ret = regflow.calculateQmin(region, time, a, b, qls_m3s, dm);

        debug('Calculate Minimal Annual Discharge: XT=%s a=%s b=%s months=%s result=%s', xt, a, b, dm, ret);

        res.status(200).json({
            qmin: ret,
            unit: "m³/s"
        })
    }

    run().catch(next);
});

router.get('/calculate_critical_duration/:region/:time/:qf/:a/:b/:qls_m3s', function(req,res,next){
    async function run(){
        var region = req.params['region'];
        var time   = req.params['time'];
        var xt = regflow.getXTCoef(region,time);

        var a = req.params['a'];
        var b = req.params['b'];
        var qf = parseFloat(req.params['qf']);
        var qls_m3s = parseFloat(req.params['qls_m3s']);

        var ret = regflow.calculateCriticalDuration(qf,region,time,a,b,qls_m3s);

        res.status(200).json({
            duration: ret,
            duration_rounded: parseFloat(ret.toFixed(1)),
            units: "months"
        })
    }

    run().catch(next);
});

/**
 * Calculate 95% permanence values
 */
router.get('/calculate_q95/:region/:qls_m3s/:area_km2', function(req,res,next){
    async function run(){
        var region = req.params['region'];
        var qls_m3s = req.params['qls_m3s'];
        var area_km2 = parseFloat(req.params['area_km2']);

        var ret = regflow.calculateQ95(region,qls_m3s);
        
        res.status(200).json({
            q95: ret,
            units: "m³/s",
            area_km2: area_km2,
            region: region
        })  
    }

    run().catch(next);
});

/**
 * Method to calculate Permancence values
 */
router.get('/calculate_qper/:region/:qls_m3s', function(req,res,next){
    async function run(){
        var region = req.params['region'];
        var qls_m3s = req.params['qls_m3s'];
        const pps = [5,10,15,20,25,30,40,50,60,70,75,80,85,90,95,100];
        var rets = [];
        for(var i = 0; i < pps.length; i++){
            rets.push({frequence: pps[i], discharge: regflow.calculateQ95(region, qls_m3s, i)});
        }
        
        res.status(200).json({
            values: rets
        })
    }

    run().catch(next);
});


/**
 * Calculate Q7(t) Permanence Values
 */
router.get("/calculate_q7/:region/:c/:val_a/:val_b/:qls_m3s/:area_km2", function(req,res,next){
    async function run(){
        const return_periods = [10,15,20,25,50,100];
        var time   = parseInt(req.params['time']);
        var region = req.params['region'];
        var coef_c = parseFloat(req.params['c']);
        var val_a  = parseFloat(req.params['val_a']);
        var val_b  = parseFloat(req.params['val_b']);
        var qls_m3s = parseFloat(req.params['qls_m3s']);
        var area_km2 = parseFloat(req.params['area_km2']);

        var rets = [];
        //var ret = regflow.calculateQ7T(coef_c, region, time, val_a, val_b, qls_m3s);
        debug('Return Periods: %o', return_periods);
        for(var i = 0; i < return_periods.length; i++){
            rets.push({return_period: return_periods[i], discharge: regflow.calculateQ7T(coef_c, region, i, val_a, val_b, qls_m3s), area_km2: area_km2});
        }

        res.status(200).json({
            discharges: rets
        })
    }

    run().catch(next);
})

router.get("/calculate_q7_10/:region/:c/:val_a/:val_b/:qls_m3s", function(req,res,next){
    async function run(){

        var region = req.params['region'];
        var coef_c = parseFloat(req.params['c']);
        var val_a  = parseFloat(req.params['val_a']);
        var val_b  = parseFloat(req.params['val_b']);
        var qls_m3s = parseFloat(req.params['qls_m3s']);

        var ret = regflow.calculateQ7T(coef_c, region, 0, val_a, val_b, qls_m3s);

        res.status(200).json({
            q710: ret,
            q710_rounded: parseFloat(ret.toFixed(2)),
            units: "m³/s"
        })
    }

    run().catch(next);
})

/** Find Coeficients RAU, XYZ by Coordinates */
router.get('/find_coefs/:lat/:lon', function(req,res,next){
    async function run(){
        var lat = parseFloat(req.params['lat']);
        var lon = parseFloat(req.params['lon']);

        debug('Coordinates: %s <> %s', lat, lon);

        var turf_point = turf.point([lon, lat]);

        var rau_obj = {};
        var rxyz_obj = {};

        //Find Coeficients A..U
        turf.featureEach(rau_json, function(rau,index){
            if(turf.booleanIntersects(rau.geometry, turf_point)){                                                                                                                                  
                rau_obj = rau;
                debug('A..U coefficients found: %o', rau_obj.properties);
            }
        });

        turf.featureEach(rxyz_json, function(rxyz,index){
            if(turf.booleanIntersects(rxyz.geometry, turf_point)){
                rxyz_obj = rxyz;
                debug('XYZ Region found: %o', rxyz_obj.properties);
            }
        })

        if (!rau_obj.properties || !rxyz_obj.properties) {
            return res.status(404).json({ error: 'Coefficients not found for the informed coordinates' });
        }

        res.status(200).json({ xyz: rxyz_obj.properties, rau: rau_obj.properties })
    }

    run().catch(next);
});

router.get('/find_coefs_by_region/:lat/:lon', function(req,res,next){
    async function run(){
        var lat = parseFloat(req.params['lat']);
        var lon = parseFloat(req.params['lon']);

        const turf_point = turf.point([lon, lat]);
        var point_is_valid = false;

        let city_obj = {};
        let ottobacia_obj = {};
        let ottotrecho_obj = {};

        let isolines_obj = [];
        let rau_obj = {};
        let rxyz_obj = {};

        debug('Coordinates: %s <> %s', lat, lon);

        //Check if point in São Paulo
        //Check if point in Cities or State SP
        turf.featureEach(limite_sp_json, function(uf_sp, index){
            //console.log("UF: ", uf_sp);
            if(turf.booleanPointInPolygon(turf_point, uf_sp)){
                point_is_valid = true;
            }
        })

        debug('Point in SP: %s', point_is_valid);

        //Point Outside UF State
        if(!point_is_valid){
            return res.status(400).json({
                latitude: lat,
                longitude: lon,
                error: 'Point outside SP'
            });
        } else {

            //Check Ottobacia
            ottobacia_obj = findContainingFeature(basinBounds, turf_point, lon, lat) || {};
            if (!ottobacia_obj.geometry) return res.status(404).json({ error: 'Basin not found' });

            //Find Isolines por Ottotrecho
            turf.featureEach(isolines_json, function(isoline, index){
                //console.log("Isoline Each: ", isoline)
                if(turf.booleanIntersects(ottobacia_obj.geometry, isoline.geometry)){
                    isolines_obj.push(isoline);
                    debug('Isolines found: %s', isoline.geometry.type);
                }
            });

            //Find Ottotrecho por Ottobacia
            ottotrecho_obj = ottotrechosByBasin[ottobacia_obj.properties.COBACIA] || [];

            var ret = regflow.getRegionsCoeficientsByGeometry(ottobacia_obj, 1, { units: 'kilometers' }, 'area');

            debug('Result: %o', ret);

            res.status(200).json({
                ottobacia: ottobacia_obj,
                ottotrecho: ottotrecho_obj,
                result: ret
            })
        }
    }

    run().catch(next);
});

/**
 * Merge all layers by coordinates
 */
const openApiSpec = require('../public/openapi.json');

router.get('/health', function(req, res) {
    const ottobaciasCount = Array.isArray(basinBounds) ? basinBounds.length : 0;
    const layersLoaded = ottobaciasCount > 0;
    res.status(layersLoaded ? 200 : 503).json({
        status: layersLoaded ? 'ok' : 'degraded',
        uptime_s: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
        layers_loaded: layersLoaded,
        ottobacias_count: ottobaciasCount
    });
});

router.get('/openapi.json', function(req, res) {
    const activeBasePath = req.app && req.app.locals && typeof req.app.locals.resolveBasePath === 'function'
        ? req.app.locals.resolveBasePath(req)
        : '';
    res.status(200).json({
        ...openApiSpec,
        servers: [
            {
                url: activeBasePath || '/',
                description: activeBasePath ? `Servidor atual (subpath ${activeBasePath})` : 'Servidor local / ambiente atual'
            }
        ]
    });
});

router.get('/regularization_catalog', function(req, res) {
    const catalog = regflow.getRegionalParametersCatalog();
    res.status(200).json({
        ...catalog,
        example: {
            title: 'Rio Buquira ou do Ferrão (Paraíba do Sul — Exemplo DAEE 1988)',
            region: 'H',
            rxyz: 'Z',
            area_km2: 401.5,
            avg_rainfall_mm: 1685,
            avg_discharge_m3s: 9.48,
            qf_m3s: 5.0,
            return_period_years: 10,
            failure_probability_percent: 10
        }
    });
});

router.post('/regularization_simulation', limitCoordinateRequests, function(req, res, next) {
    try {
        const body = req.body || {};
        const requested = Array.isArray(body.scenarios) ? body.scenarios : [];
        if (requested.length < 1 || requested.length > 12) {
            const error = new Error('Informe entre 1 e 12 cenários de regularização de vazão.');
            error.status = 400;
            throw error;
        }

        const base = body.base || {};
        const results = requested.map((item, idx) => {
            const regionRaw = String(item.region || base.region || '').trim().toLowerCase();
            const hasSingleRegion = /^[a-u]$/.test(regionRaw);
            const regionLabel = String(item.region_label || base.region_label || (hasSingleRegion ? regionRaw.toUpperCase() : 'Ponderada')).trim();

            let coefA = Number(item.coef_a ?? base.coef_a);
            let coefB = Number(item.coef_b ?? base.coef_b);
            if ((!Number.isFinite(coefA) || !Number.isFinite(coefB)) && hasSingleRegion) {
                const ab = regflow.getMeansABCoef(regionRaw);
                coefA = ab.a;
                coefB = ab.b;
            }

            let avgQ = Number(item.avg_discharge_m3s ?? base.avg_discharge_m3s);
            if (!Number.isFinite(avgQ) || avgQ <= 0) {
                const areaKm2 = Number(item.area_km2 ?? base.area_km2);
                const rainfallMm = Number(item.avg_rainfall_mm ?? base.avg_rainfall_mm);
                let avgA = Number(item.avg_a ?? base.avg_a);
                let avgB = Number(item.avg_b ?? base.avg_b);
                if ((!Number.isFinite(avgA) || !Number.isFinite(avgB)) && hasSingleRegion) {
                    const rel = regflow.getRelationRainToFlowRate(regionRaw);
                    avgA = rel.param_a;
                    avgB = rel.param_b;
                }
                if (Number.isFinite(areaKm2) && areaKm2 > 0 && Number.isFinite(rainfallMm) && rainfallMm > 0 && Number.isFinite(avgA) && Number.isFinite(avgB)) {
                    avgQ = regflow.calculateAvgFlowRateLongPeriod(avgA, avgB, rainfallMm, areaKm2);
                }
            }

            let calc;
            try {
                calc = regflow.calculateRegularizationScenario({
                    qf_m3s: item.qf_m3s,
                    return_period_years: item.return_period_years,
                    failure_probability_percent: item.failure_probability_percent,
                    avg_discharge_m3s: avgQ,
                    coef_a: coefA,
                    coef_b: coefB,
                    xt: item.xt,
                    xt_by_period: item.xt_by_period || base.xt_by_period,
                    region: hasSingleRegion ? regionRaw : undefined
                });
            } catch (err) {
                const validationError = new Error(`Cenário ${idx + 1}: ${err.message}`);
                validationError.status = 400;
                throw validationError;
            }

            const defaultName = `Cenário ${idx + 1} — QF ${numericFormat.format(calc.qf_m3s)} m³/s · ${Number(calc.failure_probability_percent.toFixed(2)).toString().replace('.', ',')}% (T=${Number(calc.return_period_years.toFixed(1)).toString().replace('.', ',')} anos)`;
            return {
                id: String(item.id || `reg-scenario-${idx + 1}`).slice(0, 80),
                name: String(item.name || defaultName).trim().slice(0, 120),
                region_label: regionLabel,
                ...calc
            };
        });

        res.status(200).json({
            k_seconds_per_month: 2628000,
            scenarios: results
        });
    } catch (error) {
        next(error);
    }
});

router.get('/isohyet_catalog', function(req, res) {
    res.status(200).json(isohyetCatalog);
});

router.get('/isohyet_catalog/:id', function(req, res) {
    const layer = isohyetLayers[req.params.id];
    if (!layer) return res.status(404).json({ error: 'Camada de isoietas não encontrada' });
    res.status(200).json(layer);
});

router.post('/isohyet_editor_layer', limitCoordinateRequests, function(req, res, next) {
    try {
        const layer = isohyetLayers[req.body.layerId];
        if (!layer) return res.status(404).json({ error: 'Camada de isoietas não encontrada' });
        const basin = validateBasinGeometry(req.body.geometry, { allowOfficialBasin: true }).geometry;
        const clipped = [];
        const basinBbox = turf.bbox(basin);
        turf.featureEach(layer, feature => {
            const fb = turf.bbox(feature);
            if (!boundsIntersect(basinBbox, fb)) return;
            let intersection = null;
            try {
                intersection = turf.intersect(feature, basin);
            } catch (_) {
                const coords = [];
                turf.flattenEach(basin, poly => {
                    if (!boundsIntersect(turf.bbox(poly), fb)) return;
                    try {
                        const hit = turf.intersect(feature, poly);
                        if (!hit || !hit.geometry) return;
                        if (hit.geometry.type === 'Polygon') coords.push(hit.geometry.coordinates);
                        else if (hit.geometry.type === 'MultiPolygon') coords.push(...hit.geometry.coordinates);
                    } catch (__) {}
                });
                if (coords.length === 1) intersection = turf.polygon(coords[0]);
                else if (coords.length > 1) intersection = turf.multiPolygon(coords);
            }
            if (intersection) { intersection.properties = { ...feature.properties }; clipped.push(intersection); }
        });
        res.status(200).json(turf.featureCollection(clipped));
    } catch (error) { next(error); }
});

router.post('/isohyet_adjust', limitCoordinateRequests, function(req, res, next) {
    try {
        const layer = req.body.layer ? validateRainfallLayer(req.body.layer) : isohyetLayers[req.body.layerId];
        if (!layer) {
            const error = new Error('Camada de isoietas não encontrada'); error.status = 404; throw error;
        }
        const region = validateBasinGeometry(req.body.region, { allowPartialStateOverlap: true }).geometry;
        const percentage = Number(req.body.percentage);
        if (!Number.isFinite(percentage) || percentage <= -100 || percentage > 500) {
            const error = new Error('A variação deve ser maior que -100% e menor ou igual a 500%'); error.status = 400; throw error;
        }
        const adjusted = [];
        turf.featureEach(layer, feature => {
            const intersection = turf.intersect(feature, region);
            if (!intersection) { adjusted.push(feature); return; }
            const outside = turf.difference(feature, region);
            if (outside) { outside.properties = { ...feature.properties }; adjusted.push(outside); }
            intersection.properties = { ...feature.properties, ID: Number(feature.properties.ID) * (1 + percentage / 100) };
            adjusted.push(intersection);
        });
        res.status(200).json(turf.featureCollection(adjusted));
    } catch (error) { next(error); }
});

router.post('/isohyet_simulation', limitCoordinateRequests, function(req, res, next) {
    async function run() {
        const validated = validateBasinGeometry(req.body && req.body.geometry, { allowOfficialBasin: true });
        const requested = req.body && req.body.scenarios;
        if (!Array.isArray(requested) || requested.length < 1 || requested.length > 6) {
            const error = new Error('Select between 1 and 6 isohyet scenarios');
            error.status = 400;
            throw error;
        }
        const seenNames = new Set();
        const scenarios = requested.map((scenario, index) => {
            const name = String(scenario && scenario.name || '').trim().slice(0, 80);
            if (!name || seenNames.has(name.toLocaleLowerCase('pt-BR'))) {
                const error = new Error(`Scenario ${index + 1} must have a unique name`);
                error.status = 400;
                throw error;
            }
            seenNames.add(name.toLocaleLowerCase('pt-BR'));
            if (isohyetLayers[scenario.id] && !scenario.layer) return { id: scenario.id, name, layer: isohyetLayers[scenario.id], source: 'catalog' };
            return { id: String(scenario.id || `upload-${index + 1}`).slice(0, 80), name, layer: validateRainfallLayer(scenario.layer), source: 'upload' };
        });

        const regionCoefs = regflow.getRegionsCoeficientsByGeometry(validated.geometry, 1, { units: 'kilometers' }, 'area');
        const rauCoveredArea = (regionCoefs.rau.bands || []).reduce((sum, band) => sum + Number(band.properties.partial_area || 0), 0);
        const referenceAreaKm2 = rauCoveredArea > 0 ? Math.min(validated.areaKm2, rauCoveredArea) : validated.areaKm2;
        const results = scenarios.map(scenario => {
            const rainfall = regflow.getMeanRainfallByGeometry(validated.geometry, 1, { units: 'kilometers' }, 'area', scenario.layer);
            const coveredArea = (rainfall.bands || []).reduce((sum, band) => sum + Number(band.properties.partial_area || 0), 0);
            const coverage = Math.min(coveredArea / referenceAreaKm2, 1);
            if (!Number.isFinite(coverage) || coverage < 0.95) {
                const error = new Error(`Isohyet scenario "${scenario.name}" covers less than 95% of the selected basin`);
                error.status = 422;
                throw error;
            }
            const flows = calculateFlows(regionCoefs, rainfall, validated.areaKm2);
            return {
                id: scenario.id,
                name: scenario.name,
                source: scenario.source,
                coverage,
                rainfall: rainfall.avg_areas,
                avg_discharge: flows.avg_discharge,
                q95: flows.q95,
                q710: flows.q710,
                bands: rainfall.bands
            };
        });
        res.status(200).json({ area_km2: validated.areaKm2, geometry: validated.geometry, scenarios: results });
    }
    run().catch(next);
});

router.post('/geometry_calculate', limitCoordinateRequests, function(req, res, next) {
    async function run() {
        const validated = validateBasinGeometry(req.body && req.body.geometry, { allowOfficialBasin: true });
        const response = await calculateGeometry(validated.geometry, { source: 'drawn-geometry', includeElevation: false, includeBasinOverlaps: true, includeIntersectingStreams: true });
        response.calculation_memorial = calculationMemorial(response);
        res.status(200).json(response);
    }
    run().catch(next);
});

const delineateDem = require('../services/dem-delineation').createDelineator();
router.get('/ottobacias/:cod/microbasins', limitCoordinateRequests, async function(req,res,next) {
    const area = Number(req.query.min_drainage_area_km2 === undefined ? (process.env.DEM_MIN_DRAINAGE_AREA_KM2 || 0.1) : req.query.min_drainage_area_km2);
    if (!Number.isFinite(area) || area <= 0) return res.status(400).json({error:'min_drainage_area_km2 deve ser positivo.'});
    const basin = ottobaciasByCode[req.params.cod];
    if (!basin) return res.status(404).json({error:'Ottobacia não encontrada.'});
    try {
        const result = await delineateDem.microbasins(basin,area);
        res.set('X-Cache',result.cache).json(result.value);
    } catch(error) {
        if(error.status) return res.status(error.status).json({error:error.message});
        next(error);
    }
});

router.get('/dem_delineation/:lat/:lon', limitCoordinateRequests, async function(req, res, next) {
    const lat = Number(req.params.lat);
    const lon = Number(req.params.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return res.status(400).json({ error: 'Coordenadas inválidas.' });
    }
    const basin = findContainingFeature(basinBounds, turf.point([lon, lat]), lon, lat);
    if (!basin) return res.status(404).json({ error: 'Ottobacia não encontrada.' });
    try {
        res.json(await delineateDem(basin, [lon, lat], ottotrechosByBasin[basin.properties.COBACIA] || [],
            (upstreamCodesByJusante[basin.properties.COBACIA] || []).map(code => ottobaciasByCode[code]).filter(Boolean)));
    } catch (error) {
        if (error.status) return res.status(error.status).json({ error: error.message });
        next(error);
    }
});

router.get('/coords_join/:lat/:lon', limitCoordinateRequests, function(req,res,next){
    async function run(){
        var lat = parseFloat(req.params['lat']);
        var lon = parseFloat(req.params['lon']);
        const includeUpstream = req.query.include_upstream === 'true' || req.query.include_upstream === '1';
        const includeTopography = !(req.query.include_topography === 'false' || req.query.include_topography === '0');
        const partialBasin = !(req.query.partial_basin === 'false' || req.query.partial_basin === '0');

        const cacheKey = `${lat},${lon},dem-nearest:${process.env.DEM_MIN_DRAINAGE_AREA_KM2 || 0.1},${includeTopography ? 'topo' : 'no-topo'},${includeUpstream ? 'up' : 'single'},${partialBasin ? 'part' : 'full'}`;
        const cached = coordinateCache.get(cacheKey);
        if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
            res.set('X-Cache', 'HIT');
            return res.status(200).json(cached.value);
        }

        debug('Coordinates: %s <> %s', lat, lon);

        const turf_point = turf.point([lon, lat]);

        //console.log("Turf point: ", turf_point);

        let ottobacia_obj = {};
        let ottotrecho_obj = {};

        let isolines_obj = [];
        let rau_obj = {};
        let rxyz_obj = {};

        let point_is_valid = false;

        //Check if point in Cities or State SP
        turf.featureEach(limite_sp_json, function(uf_sp, index){
            //console.log("UF: ", uf_sp);
            if(turf.booleanPointInPolygon(turf_point, uf_sp)){
                point_is_valid = true;
            }
        })

        //console.log("Point in SP: ", point_is_valid);

        //Point Outside UF State
        if(!point_is_valid){
            return res.status(400).json({
                latitude: lat,
                longitude: lon,
                error: 'Point outside SP'
            });
        }       

        //Check Ottobacia
        ottobacia_obj = findContainingFeature(basinBounds, turf_point, lon, lat) || {};
        if (!ottobacia_obj.geometry) return res.status(404).json({ error: 'Basin not found for the informed coordinates' });

        //Find Isolines por Ottotrecho
        turf.featureEach(isolines_json, function(isoline, index){
            //console.log("Isoline Each: ", isoline)
            if(turf.booleanIntersects(ottobacia_obj.geometry, isoline.geometry)){
                isolines_obj.push(isoline);
                //console.log("Isolines finded: ", isoline.geometry.type);
            }
        });

        //Find Ottotrecho por Ottobacia
        const startBasinCode = String(ottobacia_obj.properties.COBACIA);
        let upstreamBasinCodes = collectUpstreamBasinCodes(startBasinCode);
        ottotrecho_obj = await enrichStreamSegments(ottotrechosByBasin[startBasinCode] || []);
        const fullBasinAreaKm2 = turf.area(ottobacia_obj) / 1000000;
        let demResult = null;
        let topographyResult = null;
        if (partialBasin) {
            try {
                demResult = await delineateDem(ottobacia_obj, [lon, lat], ottotrechosByBasin[startBasinCode] || [],
                    (upstreamCodesByJusante[startBasinCode] || []).map(code => ottobaciasByCode[code]).filter(Boolean), { includeTopography });
                topographyResult = demResult;
            } catch (error) {
                if (error.status) return res.status(error.status).json({ error: error.message });
                throw error;
            }
            upstreamBasinCodes = [...new Set(demResult.contributing_upstream_codes.flatMap(code =>
                [code, ...collectUpstreamBasinCodes(code)]))].filter(code => code !== startBasinCode);
        }
        if (!partialBasin && includeTopography) {
            try {
                topographyResult = await delineateDem.topography(ottobacia_obj);
            } catch (error) {
                topographyResult = { topography: null, topography_warning: error.message };
            }
        }
        const localBasin = demResult ? { ...demResult.contributing_area,
            properties: { ...ottobacia_obj.properties, is_upstream_subbasin: true, delineation_method: demResult.method }
        } : ottobacia_obj;
        const localAreaKm2 = turf.area(localBasin) / 1000000;
        const splitResult = {
            upstreamBasin: localBasin,
            fullAreaKm2: fullBasinAreaKm2,
            upstreamAreaKm2: localAreaKm2,
            areaProportion: fullBasinAreaKm2 > 0 ? Math.min(localAreaKm2 / fullBasinAreaKm2, 1) : 1,
            crossSection: demResult ? { line: demResult.divide, stream_point: demResult.snapped_point,
                method: demResult.method, snap_distance_m: demResult.snap_distance_m } : null
        };
        let ottobacia_full_obj = ottobacia_obj;
        ottobacia_obj = splitResult.upstreamBasin;
        let totalUpstreamAreaKm2 = splitResult.upstreamAreaKm2;
        let totalFullAreaKm2 = splitResult.fullAreaKm2;
        const primaryTrechoProps = ottotrecho_obj[0] && ottotrecho_obj[0].properties || {};
        const upstreamBasinsSummary = [{
            COBACIA: startBasinCode,
            COBACIAJUS: primaryTrechoProps.COBACIAJUS || null,
            COCURSODAG: primaryTrechoProps.COCURSODAG || null,
            NOCOMPLETO: primaryTrechoProps.NOCOMPLETO || null,
            area_km2: splitResult.upstreamAreaKm2,
            full_area_km2: splitResult.fullAreaKm2,
            area_proportion: splitResult.areaProportion,
            length_km: (ottotrecho_obj || []).reduce((sum, item) => sum + Number(item.properties && item.properties.NUCOMPTREC || 0), 0),
            is_clicked_basin: true
        }];

        if (includeUpstream && upstreamBasinCodes.length > 0) {
            const combinedCoords = [];
            const appendCoords = feat => {
                if (!feat || !feat.geometry) return;
                if (feat.geometry.type === 'Polygon') combinedCoords.push(feat.geometry.coordinates);
                else if (feat.geometry.type === 'MultiPolygon') combinedCoords.push(...feat.geometry.coordinates);
            };
            appendCoords(splitResult.upstreamBasin);
            const fullFeatures = [ottobacia_full_obj];

            for (const code of upstreamBasinCodes) {
                const upBasin = ottobaciasByCode[code];
                if (!upBasin) continue;
                const upArea = turf.area(upBasin) / 1000000;
                if (!Number.isFinite(upArea) || upArea <= 0) continue;
                appendCoords(upBasin);
                fullFeatures.push(upBasin);
                totalUpstreamAreaKm2 += upArea;
                totalFullAreaKm2 += upArea;
                const upSegments = ottotrechosByBasin[code] || [];
                ottotrecho_obj.push(...upSegments);
                const segProps = upSegments[0] && upSegments[0].properties || {};
                upstreamBasinsSummary.push({
                    COBACIA: code,
                    COBACIAJUS: segProps.COBACIAJUS || null,
                    COCURSODAG: segProps.COCURSODAG || null,
                    NOCOMPLETO: segProps.NOCOMPLETO || null,
                    area_km2: upArea,
                    full_area_km2: upArea,
                    area_proportion: 1,
                    length_km: upSegments.reduce((sum, item) => sum + Number(item.properties && item.properties.NUCOMPTREC || 0), 0),
                    is_clicked_basin: false
                });
            }

            ottobacia_obj = turf.multiPolygon(combinedCoords, {
                ...(ottobacia_full_obj.properties || {}),
                is_upstream_subbasin: true,
                is_upstream_network: true,
                upstream_basin_codes: [startBasinCode, ...upstreamBasinCodes]
            });
            ottobacia_full_obj = turf.featureCollection(fullFeatures);
        }

        const totalAreaProportion = totalFullAreaKm2 > 0 ? Math.min(totalUpstreamAreaKm2 / totalFullAreaKm2, 1) : 1;

        var region_coefs = regflow.getRegionsCoeficientsByGeometry(ottobacia_obj, 1, { units: 'kilometers' }, 'area');
        //console.log("Coeficients: ", region_coefs);

        //Find Coeficients A..U
        /*turf.featureEach(rau_json, function(rau,index){
            if(turf.booleanIntersects(rau.geometry, turf_point)){                                                                                                                                  
                rau_obj = rau;
                debug('A..U coefficients found: %s', rau_obj.geometry.type);
            }
        });

        turf.featureEach(rxyz_json, function(rxyz,index){
            if(turf.booleanIntersects(rxyz.geometry, turf_point)){
                rxyz_obj = rxyz;
                debug('XYZ Region found: %s', rxyz_obj.geometry.type);
            }
        })*/

        //Calculate Anual Average Rainfall By Basin Geometry
        var area_calc     = totalUpstreamAreaKm2;
        var rainfall_calc = { avg_areas: region_coefs.isolines.avg_rain_areas, avg_points: region_coefs.isolines.avg_rain_points, bands: region_coefs.isolines.bands };
        var altitude_calc = await regflow.getElevationByCoords(lat,lon);

        debug('Elevation: %o', altitude_calc);

        if ([region_coefs.rau.avg_a, region_coefs.rau.avg_b, region_coefs.rau.coef_a, region_coefs.rau.coef_b, region_coefs.rxyz.coef_c, rainfall_calc.avg_areas].some(value => !Number.isFinite(value))) {
            return res.status(422).json({ error: 'Unable to calculate regional coefficients for this basin' });
        }

        var avg_discharge = regflow.calculateAvgFlowRateLongPeriod(region_coefs.rau.avg_a, region_coefs.rau.avg_b, rainfall_calc.avg_areas, area_calc);

        var avg_q95s_weight = [];
        var avg_q710_weight = [];
        

        _.each(region_coefs.rau.bands, function(region_rau, region_rau_key){
            //console.log(region_rau_key," => ",region_rau);
            let q95  = regflow.calculateQ95(region_rau.properties.region, avg_discharge);
            let q710 = regflow.calculateQ7T(region_coefs.rxyz.coef_c, region_rau.properties.region, 0, region_rau.properties.coef_a, region_rau.properties.coef_b, avg_discharge); 
            
            debug('Q710[%s] => %s', region_rau.properties.region, q710);
            debug('Q95[%s] => %s', region_rau.properties.region, q95);

            avg_q95s_weight.push({value: q95, weight: region_rau.properties.partial_area});
            avg_q710_weight.push({value: q710, weight: region_rau.properties.partial_area});
        });

        var q95_calc  = regflow.calculateAvgByWeight(avg_q95s_weight);
        var q710_calc = regflow.calculateAvgByWeight(avg_q710_weight);

        var qmin_calc = null;
        /*q95_calc      = regflow.calculateQ95(rau_obj.properties.REGIAO, 14);
        q710_calc     = regflow.calculateQ7T(rxyz_obj.properties.C, rau_obj.properties.REGIAO, 0, rau_obj.properties.A, rau_obj.properties.B, avg_discharge);
        qmin_calc     = regflow.calculateQmin(rau_obj.properties.REGIAO, 0, rau_obj.properties.A, rau_obj.properties.B, avg_discharge, 1);*/

        var response = {
            latitude: lat,
            longitude: lon,
            include_upstream: includeUpstream,
            partial_basin: partialBasin,
            include_topography: includeTopography,
            available_upstream_basins_count: upstreamBasinCodes.length,
            upstream_basins: upstreamBasinsSummary,
            area_km2: area_calc,
            full_area_km2: totalFullAreaKm2,
            area_proportion: totalAreaProportion,
            ottobacia_full: ottobacia_full_obj,
            cross_section: splitResult.crossSection,
            topography: topographyResult ? topographyResult.topography : null,
            topography_warning: topographyResult ? topographyResult.topography_warning : null,
            delineation: demResult ? { method: demResult.method, snap_method: demResult.snap_method,
                snapped_point: demResult.snapped_point, snap_distance_m: demResult.snap_distance_m,
                min_drainage_area_km2: demResult.min_drainage_area_km2,
                distance_to_official_stream_m: demResult.distance_to_official_stream_m,
                contributing_upstream_codes: demResult.contributing_upstream_codes,
                resolution_m: demResult.resolution_m, warnings: demResult.warnings } : null,
            altitude: altitude_calc,
            rxyz: region_coefs.rxyz,
            rau: region_coefs.rau,
            isolines: rainfall_calc,
            ottotrecho: ottotrecho_obj,
            ottobacia: ottobacia_obj,
            /*city: city_obj,*/
            avg_discharge: avg_discharge,
            q95:  q95_calc,
            q710: q710_calc,
            qmin: qmin_calc
        };

        response.calculation_memorial = calculationMemorial(response);
        coordinateCache.set(cacheKey, { createdAt: Date.now(), value: response });
        if (coordinateCache.size > 500) {
            const oldestKey = coordinateCache.keys().next().value;
            coordinateCache.delete(oldestKey);
        }
        res.set('X-Cache', 'MISS');
        res.status(200).json(response)
    }
    run().catch(next);
})


module.exports = router;
