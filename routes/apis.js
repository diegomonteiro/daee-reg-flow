var express = require('express');
var router  = express.Router();
var axios   = require('axios');
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

    run().catch(console.log);
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

    run().catch(console.log);
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
    
    run().catch(console.log);
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

    run().catch(console.log);
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

    run().catch(console.log);
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

        ret = regflow.calculateCriticalDuration(qf,region,time,a,b,qls_m3s);

        res.status(200).json({
            duration: ret,
            duration_rounded: parseFloat(ret.toFixed(1)),
            units: "months"
        })
    }

    run().catch(console.log);
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

    run().catch(console.log);
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

    run().catch(console.log);
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

    run().catch(console.log);
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

    run().catch(console.log);
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

        res.status(200).json({
            xyz: rxyz_obj.properties,
            rau: rau_obj.properties
        })
    }

    run().catch(console.log);
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
            res.status(400).json({
                latitude: lat,
                longitude: lon,
                error: 'Point outside SP'
            });
        }else{
 
            //Check Ottobacia
            turf.featureEach(ottobacias_json, function(ottobacia, index){
                //console.log(index," => ", ottobacia.geometry.type);

                if(turf.booleanIntersects(ottobacia.geometry, turf_point)){
                    ottobacia_obj = ottobacia;
                    console.log("Ottobasin finded: ", ottobacia_obj.geometry.type);
                }
            });

            //Find Isolines por Ottotrecho
            turf.featureEach(isolines_json, function(isoline, index){
                //console.log("Isoline Each: ", isoline)
                if(turf.booleanIntersects(ottobacia_obj.geometry, isoline.geometry)){
                    isolines_obj.push(isoline);
                    console.log("Isolines finded: ", isoline.geometry.type);
                }
            });

            //Find Ottotrecho por Ottobacia
            ottotrecho_obj = _.filter(ottotrechos_json.features, function(e){
                return e.properties.COBACIA == ottobacia_obj.properties.COBACIA
            });

            var ret = regflow.getRegionsCoeficientsByGeometry(ottobacia_obj, 1, 'kilometers','area');

            console.log("Result: ", ret);

            res.status(200).json({
                ottobacia: ottobacia_obj,
                ottotrecho: ottotrecho_obj,
                result: ret
            })
        }
    }

    run().catch(console.log);
});

/**
 * Merge all layers by coordinates
 */
router.get('/coords_join/:lat/:lon', function(req,res,next){
    async function run(){
        var lat = parseFloat(req.params['lat']);
        var lon = parseFloat(req.params['lon']);

        console.log("Coordinates: ",lat,"<>",lon);

        const turf_point = turf.point([lon, lat]);

        console.log("Turf point: ", turf_point);

        let city_obj = {};
        let ottobacia_obj = {};
        let ottotrecho_obj = {};

        let isolines_obj = [];
        let rau_obj = {};
        let rxyz_obj = {};

        let point_is_valid = false;

        //Check if point in Cities or State SP
        turf.featureEach(limite_sp_json, function(uf_sp, index){
            console.log("UF: ", uf_sp);
            if(turf.booleanPointInPolygon(turf_point, uf_sp)){
                point_is_valid = true;
            }
        })

        console.log("Point in SP: ", point_is_valid);

        //Point Outside UF State
        if(!point_is_valid){
            res.status(400).json({
                latitude: lat,
                longitude: lon,
                error: 'Point outside SP'
            });
        }       

        //Check City
        turf.featureEach(municipios_json, function (city, index) {
            if(turf.booleanIntersects(city.geometry, turf_point)){
                city_obj = city;
                console.log("City finded: ", city_obj.geometry.type);
            }
        })

        //Check Ottobacia
        turf.featureEach(ottobacias_json, function(ottobacia, index){
            //console.log(index," => ", ottobacia.geometry.type);

            if(turf.booleanIntersects(ottobacia.geometry, turf_point)){
                ottobacia_obj = ottobacia;
                console.log("Ottobasin finded: ", ottobacia_obj.geometry.type);
            }
        });

        //Find Isolines por Ottotrecho
        turf.featureEach(isolines_json, function(isoline, index){
            //console.log("Isoline Each: ", isoline)
            if(turf.booleanIntersects(ottobacia_obj.geometry, isoline.geometry)){
                isolines_obj.push(isoline);
                console.log("Isolines finded: ", isoline.geometry.type);
            }
        });

        //Find Ottotrecho por Ottobacia
        ottotrecho_obj = _.filter(ottotrechos_json.features, function(e){
            return e.properties.COBACIA == ottobacia_obj.properties.COBACIA
        });

        //Find Coeficients A..U
        turf.featureEach(rau_json, function(rau,index){
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
        })

        //Calculate Anual Average Rainfall By Basin Geometry
        area_calc     = turf.area(ottobacia_obj)/1000000;
        rainfall_calc = regflow.getMeanRainfallByGeometry(ottobacia_obj)
        altitude_calc = await regflow.getElevationByCoords(lat,lon);
        avg_discharge = regflow.calculateAvgFlowRateLongPeriod(rau_obj.properties.A_MEDIA, rau_obj.properties.B_MEDIA, rainfall_calc.avg_areas, area_calc);
        q95_calc      = regflow.calculateQ95(rau_obj.properties.REGIAO, 14);
        q710_calc     = regflow.calculateQ7T(rxyz_obj.properties.C, rau_obj.properties.REGIAO, 0, rau_obj.properties.A, rau_obj.properties.B, avg_discharge);
        qmin_calc     = regflow.calculateQmin(rau_obj.properties.REGIAO, 0, rau_obj.properties.A, rau_obj.properties.B, avg_discharge, 1);

        res.status(200).json({
            latitude: lat,
            longitude: lon,
            altitude: altitude_calc,
            rxyz: rxyz_obj.properties,
            rau: rau_obj.properties,
            isolines: rainfall_calc,
            ottotrecho: ottotrecho_obj,
            ottobacia: ottobacia_obj,
            city: city_obj,
            avg_discharge: avg_discharge,
            q95:  q95_calc,
            q710: q710_calc,
            qmin: qmin_calc
        })
    }
    run().catch(console.log);
})


module.exports = router;