var express = require('express');
var router  = express.Router();
var turf    = require('@turf/turf');

var _ = require('lodash');

const regflow = require('../models/regflow');

require("dotenv").config();

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

function limitCoordinateRequests(req, res, next) {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const current = coordinateRequests.get(key);
    if (!current || now - current.startedAt >= 60 * 1000) {
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

function validateBasinGeometry(input) {
    if (!input || input.type !== 'Feature' || !input.geometry || !['Polygon', 'MultiPolygon'].includes(input.geometry.type)) {
        const error = new Error('A valid Polygon or MultiPolygon GeoJSON feature is required');
        error.status = 400;
        throw error;
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
        if (!limite_sp_json.features.some(state => turf.booleanWithin(polygon, state))) isWithinState = false;
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
    if ([regionCoefs.rau.coef_a, regionCoefs.rau.coef_b, regionCoefs.rxyz.coef_c, rainfall.avg_areas].some(value => !Number.isFinite(value))) {
        const error = new Error('The isohyet layer does not provide valid coverage for the selected basin');
        error.status = 422;
        throw error;
    }
    const averageDischarge = regflow.calculateAvgFlowRateLongPeriod(regionCoefs.rau.coef_a, regionCoefs.rau.coef_b, rainfall.avg_areas, areaKm2);
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

async function enrichStreamSegments(segments) {
    return Promise.all((segments || []).map(async segment => {
        const endpoints = getLineEndpoints(segment);
        if (!endpoints) return segment;
        const [firstElevation, lastElevation] = await Promise.all([
            regflow.getElevationByCoords(endpoints.first[1], endpoints.first[0]),
            regflow.getElevationByCoords(endpoints.last[1], endpoints.last[0])
        ]);
        const firstMeters = firstElevation && Number.isFinite(firstElevation.max) ? firstElevation.max : null;
        const lastMeters = lastElevation && Number.isFinite(lastElevation.max) ? lastElevation.max : null;
        let upstream = null, downstream = null;
        if (firstMeters !== null && lastMeters !== null) {
            const first = { coordinates: endpoints.first, elevation_m: firstMeters };
            const last = { coordinates: endpoints.last, elevation_m: lastMeters };
            upstream = firstMeters >= lastMeters ? first : last;
            downstream = firstMeters >= lastMeters ? last : first;
        }
        return { ...segment, properties: { ...segment.properties, stream_endpoints: { first: { coordinates: endpoints.first, elevation_m: firstMeters }, last: { coordinates: endpoints.last, elevation_m: lastMeters }, upstream, downstream, elevation_source: firstMeters !== null && lastMeters !== null ? 'mapbox-terrain-v2' : null } } };
    }));
}

async function calculateGeometry(geometry, options = {}) {
    const areaKm2 = turf.area(geometry) / 1000000;
    const regionCoefs = regflow.getRegionsCoeficientsByGeometry(geometry, 1, { units: 'kilometers' }, 'area');
    const rainfall = regflow.getMeanRainfallByGeometry(geometry, 1, { units: 'kilometers' }, 'area', options.rainfallLayer || isolines_json);
    const flows = calculateFlows(regionCoefs, rainfall, areaKm2);

    const center = turf.centroid(geometry).geometry.coordinates;
    const altitude = options.includeElevation === false ? null : await regflow.getElevationByCoords(center[1], center[0]);
    const streamSegments = await enrichStreamSegments(options.ottotrecho || []);
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

        console.log("Qf: "+qf+" - A: "+a+" - B: "+b+" - Qa:"+q+" - months: "+months);
        //var ret = (Math.pow(qf-(xt*a*q),2)/(4*xt*b*q))*k;
        var ret = regflow.calculateVolumeRegularization(qf,region,time,a,b,q,months);

        console.log("Max: "+ret);

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

        console.log("AVG.discharge => "+ret);

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

        console.log("XT: ", xt);

        var ret = regflow.calculateQmin(region, time, a, b, qls_m3s, dm);

        console.log("Calculate Minimal Anual Discharge: ",xt,", ",a,", ",b,", ",dm," => ",ret);

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
        console.log("Return Periods: ", return_periods);
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

        console.log("Coordinates: ",lat,"<>",lon);

        var turf_point = turf.point([lon, lat]);

        var rau_obj = {};
        var rxyz_obj = {};

        //Find Coeficients A..U
        turf.featureEach(rau_json, function(rau,index){
            if(turf.booleanIntersects(rau.geometry, turf_point)){                                                                                                                                  
                rau_obj = rau;
                console.log("A..U coeficients finded: ", rau_obj.properties);
            }
        });

        turf.featureEach(rxyz_json, function(rxyz,index){
            if(turf.booleanIntersects(rxyz.geometry, turf_point)){
                rxyz_obj = rxyz;
                console.log("XYZ Region finded: ", rxyz_obj.properties);
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

        console.log("Coordinates: ",lat,"<>",lon);

        //Check if point in São Paulo
        //Check if point in Cities or State SP
        turf.featureEach(limite_sp_json, function(uf_sp, index){
            //console.log("UF: ", uf_sp);
            if(turf.booleanPointInPolygon(turf_point, uf_sp)){
                point_is_valid = true;
            }
        })

        console.log("Point in SP: ", point_is_valid);

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
                    console.log("Isolines finded: ", isoline.geometry.type);
                }
            });

            //Find Ottotrecho por Ottobacia
            ottotrecho_obj = ottotrechosByBasin[ottobacia_obj.properties.COBACIA] || [];

            var ret = regflow.getRegionsCoeficientsByGeometry(ottobacia_obj, 1, { units: 'kilometers' }, 'area');

            console.log("Result: ", ret);

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
        const basin = validateBasinGeometry(req.body.geometry).geometry;
        const clipped = [];
        turf.featureEach(layer, feature => {
            const intersection = turf.intersect(feature, basin);
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
        const region = validateBasinGeometry(req.body.region).geometry;
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
        const validated = validateBasinGeometry(req.body && req.body.geometry);
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
        const results = scenarios.map(scenario => {
            const rainfall = regflow.getMeanRainfallByGeometry(validated.geometry, 1, { units: 'kilometers' }, 'area', scenario.layer);
            const coveredArea = (rainfall.bands || []).reduce((sum, band) => sum + Number(band.properties.partial_area || 0), 0);
            const coverage = Math.min(coveredArea / validated.areaKm2, 1);
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
        const validated = validateBasinGeometry(req.body && req.body.geometry);
        const response = await calculateGeometry(validated.geometry, { source: 'drawn-geometry', includeElevation: false });
        res.status(200).json(response);
    }
    run().catch(next);
});

router.get('/coords_join/:lat/:lon', limitCoordinateRequests, function(req,res,next){
    async function run(){
        var lat = parseFloat(req.params['lat']);
        var lon = parseFloat(req.params['lon']);

        const cacheKey = `${lat.toFixed(5)},${lon.toFixed(5)}`;
        const cached = coordinateCache.get(cacheKey);
        if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
            res.set('X-Cache', 'HIT');
            return res.status(200).json(cached.value);
        }

        console.log("Coordinates: ",lat,"<>",lon);

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
        ottotrecho_obj = ottotrechosByBasin[ottobacia_obj.properties.COBACIA] || [];

        var region_coefs = regflow.getRegionsCoeficientsByGeometry(ottobacia_obj, 1, { units: 'kilometers' }, 'area');
        //console.log("Coeficients: ", region_coefs);

        //Find Coeficients A..U
        /*turf.featureEach(rau_json, function(rau,index){
            if(turf.booleanIntersects(rau.geometry, turf_point)){                                                                                                                                  
                rau_obj = rau;
                console.log("A..U coeficients finded: ", rau_obj.geometry.type);
            }
        });

        turf.featureEach(rxyz_json, function(rxyz,index){
            if(turf.booleanIntersects(rxyz.geometry, turf_point)){
                rxyz_obj = rxyz;
                console.log("XYZ Region finded: ", rxyz_obj.geometry.type);
            }
        })*/

        //Calculate Anual Average Rainfall By Basin Geometry
        var area_calc     = turf.area(ottobacia_obj)/1000000;
        var rainfall_calc = regflow.getMeanRainfallByGeometry(ottobacia_obj);
        var altitude_calc = await regflow.getElevationByCoords(lat,lon);

        console.log("Elevation: ", altitude_calc);

        if ([region_coefs.rau.coef_a, region_coefs.rau.coef_b, region_coefs.rxyz.coef_c, rainfall_calc.avg_areas].some(value => !Number.isFinite(value))) {
            return res.status(422).json({ error: 'Unable to calculate regional coefficients for this basin' });
        }

        var avg_discharge = regflow.calculateAvgFlowRateLongPeriod(region_coefs.rau.coef_a, region_coefs.rau.coef_b, rainfall_calc.avg_areas, area_calc);

        var avg_q95s_weight = [];
        var avg_q710_weight = [];
        

        _.each(region_coefs.rau.bands, function(region_rau, region_rau_key){
            //console.log(region_rau_key," => ",region_rau);
            let q95  = regflow.calculateQ95(region_rau.properties.region, avg_discharge);
            let q710 = regflow.calculateQ7T(region_coefs.rxyz.coef_c, region_rau.properties.region, 0, region_rau.properties.coef_a, region_rau.properties.coef_b, avg_discharge); 
            
            console.log("Q710["+region_rau.properties.region+"] => ",q710);
            console.log("Q95["+region_rau.properties.region+"] => ",q95);

            avg_q95s_weight.push({value: q95, weight: region_rau.properties.partial_area});
            avg_q710_weight.push({value: q710, weight: region_rau.properties.partial_area});
        });

        var q95_calc  = regflow.calculateAvgByWeight(avg_q95s_weight);
        var q710_calc = regflow.calculateAvgByWeight(avg_q710_weight);

        var qmin_calc = null;
        /*q95_calc      = regflow.calculateQ95(rau_obj.properties.REGIAO, 14);
        q710_calc     = regflow.calculateQ7T(rxyz_obj.properties.C, rau_obj.properties.REGIAO, 0, rau_obj.properties.A, rau_obj.properties.B, avg_discharge);
        qmin_calc     = regflow.calculateQmin(rau_obj.properties.REGIAO, 0, rau_obj.properties.A, rau_obj.properties.B, avg_discharge, 1);*/

        ottotrecho_obj = await enrichStreamSegments(ottotrecho_obj);
        var response = {
            latitude: lat,
            longitude: lon,
            area_km2: area_calc,
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
