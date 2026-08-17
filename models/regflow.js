var turf    = require('@turf/turf');
var _       = require('lodash');

var municipios_json  = require('../public/layers/municipios.json');
var ottobacias_json  = require('../public/layers/ottobacias.json');
var ottotrechos_json = require('../public/layers/ottotrechos.json');
var isolines_json    = require('../public/layers/rain_isoline.json');
var rau_json         = require('../public/layers/rau.json');
var rxyz_json        = require('../public/layers/rxyz.json');

const return_periods = [10,15,20,25,50,100];
const d_months = [1,2,3,4,5,6];
const pps = [5,10,15,20,25,30,40,50,60,70,75,80,85,90,95,100];
//Number seconds of Month
const K = 2628000;

const regflow = {

    /**
     * Method to Get Coeficients by input Geometry
     * @param {*} basin_border_geo Basin Border
     * @param {*} cellGridSize Size off Cellgrid
     * @param {*} optionsGrid Units by distance (meters, kilometers..)
     * @param {*} weighted_by Weighted type (area less eficient, points most eficient)
     * @returns 
     */
    getRegionsCoeficientsByGeometry(basin_border_geo, cellGridSize=1, optionsGrid={units: 'kilometers'}, weighted_by='area', rainfallLayer=isolines_json){
        const bounds = turf.bbox(basin_border_geo.geometry);
        const extent = bounds;
        const point_grids = turf.pointGrid(extent, cellGridSize, optionsGrid);

        //Rau AVG Weighted
        const rau_avg_a_weighted_areas = [];
        const rau_avg_b_weighted_areas = [];
        const rau_avg_xt10_weigted_areas = [];
        const rau_avg_coef_a_weighted_areas = [];
        const rau_avg_coef_b_weighted_areas = [];
        const rau_avg_qp95_weighted_areas = [];
        const rain_avg_weighted_areas = [];
        const rain_avg_weighted_points = [];

        const isobands = [];
        const rau_bands = [];
        const rxyz_bands = [];

        const rxyz_avg_weighted_areas = [];

        //First Get Rau Object
        turf.featureEach(rau_json, function(rauFeature, rauIndex){
            //console.log("RAU Object: ", rauFeature);
            //Check points on polygon
            var pts = turf.pointsWithinPolygon(point_grids, rauFeature);

            if(pts.features.length > 0){
                //console.log("Points in Polygon: ", pts.length);

                turf.featureEach(basin_border_geo, function(basinFeature, basinIndex){
                    //Get a intersection of BasinPolygon to IsobandPolygon
                    var rau_band = turf.intersect(basinFeature, rauFeature);

                    if(rau_band){
                        //console.log("Rau Band Valid: ", rau_band);
                        var partial_area = turf.area(rau_band.geometry)/1000000;
                        var avg_rau_obj = {
                            id: rauFeature.properties.ID,
                            region: rauFeature.properties.REGIAO,
                            avg_a: rauFeature.properties.A_MEDIA,
                            avg_b: rauFeature.properties.B_MEDIA,
                            xt_10: rauFeature.properties.XT10,
                            coef_a: rauFeature.properties.A,
                            coef_b: rauFeature.properties.B,
                            qp95: rauFeature.properties.QP95,
                            partial_area: partial_area};
                        rau_band.properties = _.merge(avg_rau_obj, basinFeature.properties);
                        
                        //Weight areas coefs
                        rau_avg_a_weighted_areas.push({value: avg_rau_obj.avg_a, weight: partial_area});
                        rau_avg_b_weighted_areas.push({value: avg_rau_obj.avg_b, weight: partial_area});
                        rau_avg_xt10_weigted_areas.push({value: avg_rau_obj.xt_10, weight: partial_area});
                        rau_avg_coef_a_weighted_areas.push({value: avg_rau_obj.coef_a, weight: partial_area});
                        rau_avg_coef_b_weighted_areas.push({value: avg_rau_obj.coef_b, weight: partial_area});
                        rau_avg_qp95_weighted_areas.push({value: avg_rau_obj.qp95, weight: partial_area});

                        rau_bands.push(rau_band);                      
                    }
                })
            }
        });

        turf.featureEach(rxyz_json, function(rxyzFeature, rxyzIndex){
            //console.log("RXYZ Object: ", rxyzFeature);
            var pts = turf.pointsWithinPolygon(point_grids, rxyzFeature);

            if(pts.features.length > 0){
                turf.featureEach(basin_border_geo, function(basinFeature, basinIndex){
                    //Get a intersection of BasinPolygon to IsobandPolygon
                    var rxyz_band = turf.intersect(basinFeature, rxyzFeature);

                    if(rxyz_band){
                        var partial_area = turf.area(rxyz_band.geometry)/1000000;
                        var avg_rxyz_obj = {id: rxyzFeature.properties.ID, coef_c: rxyzFeature.properties.C, partial_area: partial_area};
                        rxyz_band.properties = _.merge(avg_rxyz_obj, basinFeature.properties);
                        
                        rxyz_avg_weighted_areas.push({value: avg_rxyz_obj.coef_c, weight: partial_area});
                        rxyz_bands.push(rxyz_band);                      
                    }
                })
            }
        });

        turf.featureEach(rainfallLayer, function(rainFeature, rainIndex){
            //Check point inside Rainfall Band
            var pts = turf.pointsWithinPolygon(point_grids, rainFeature);

            //Check if points exist
            if(pts.features.length > 0){
                //Each Basin Features to Check
                turf.featureEach(basin_border_geo, function(basinFeature, basinIndex){
                    //Get a intersection of BasinPolygon to IsobandPolygon
                    var isoband = turf.intersect(basinFeature, rainFeature);
                    //console.log("Isoband: ", isoband);

                    if(isoband){
                        var partial_area = turf.area(isoband.geometry)/1000000;
                        var avg_rain_obj = {rain: rainFeature.properties.ID, partial_area: partial_area};
                        
                        //Save's calculated partial area into isoband
                        isoband.properties = _.merge(avg_rain_obj, basinFeature.properties); 
                        
                        //console.log("Isoband Properties: ", _.merge(avg_rain_obj, basinFeature.properties));

                        rain_avg_weighted_areas.push({value: avg_rain_obj.rain, weight: partial_area});
                        isobands.push(isoband);                      
                    }
                })

                var pts_tags = turf.tag(pts, rainFeature,'ID','rain');
                var avg_rain = _.meanBy(pts_tags.features, function(o){ return o.properties.rain });
                rain_avg_weighted_points.push({value: avg_rain, weight: pts_tags.features.length});
            }
        });

        const avg_rain_areas  = this.calculateAvgByWeight(rain_avg_weighted_areas);
        const avg_rain_points = this.calculateAvgByWeight(rain_avg_weighted_points);

        return {
            rau: {
                bands: rau_bands,
                avg_a:  this.calculateAvgByWeight(rau_avg_a_weighted_areas),
                avg_b:  this.calculateAvgByWeight(rau_avg_b_weighted_areas),
                xt_10:  this.calculateAvgByWeight(rau_avg_xt10_weigted_areas),
                coef_a: this.calculateAvgByWeight(rau_avg_coef_a_weighted_areas),
                coef_b: this.calculateAvgByWeight(rau_avg_coef_b_weighted_areas),
                qp95:   this.calculateAvgByWeight(rau_avg_qp95_weighted_areas)
            },
            rxyz: {
                bands: rxyz_bands,
                coef_c: this.calculateAvgByWeight(rxyz_avg_weighted_areas)
            },
            isolines: {
                avg_rain_areas: avg_rain_areas,
                avg_rain_points: avg_rain_points,
                bands: isobands
            }
        };
    },

    /**
     * Method to get Mean of Precipitation Using Geometry (GeoJSON)
     * @param {*} basin_border_geo GeoJSON with Borders
     * @param {*} cellGridSize Size of Cellgrid
     * @param {*} optionsGrid {units: 'kilometers'}
     * @param {*} weighted_by Weighted options: {area,points}
     * @returns 
     */
    getMeanRainfallByGeometry(basin_border_geo, cellGridSize=1, optionsGrid={units: 'kilometers'}, weighted_by='area', rainfallLayer=isolines_json){
        const bounds = turf.bbox(basin_border_geo.geometry);

        const extent = bounds;   
        const point_grids = turf.pointGrid(extent, cellGridSize, optionsGrid);

        let rain_avg_weighted_areas = [];
        let rain_avg_weighted_points = [];
        let isobands = [];

        turf.featureEach(rainfallLayer, function(rainFeature, rainIndex){
            //Check point inside Rainfall Band
            var pts = turf.pointsWithinPolygon(point_grids, rainFeature);

            //Check if points exist
            if(pts.features.length > 0){
                //Each Basin Features to Check
                turf.featureEach(basin_border_geo, function(basinFeature, basinIndex){
                    //Get a intersection of BasinPolygon to IsobandPolygon
                    var isoband = turf.intersect(basinFeature, rainFeature);
                    //console.log("Isoband: ", isoband);

                    if(isoband){
                        var partial_area = turf.area(isoband.geometry)/1000000;
                        var avg_rain_obj = {rain: rainFeature.properties.ID, partial_area: partial_area};
                        
                        //Save's calculated partial area into isoband
                        isoband.properties = _.merge(avg_rain_obj, basinFeature.properties); 
                        
                        //console.log("Isoband Properties: ", _.merge(avg_rain_obj, basinFeature.properties));

                        rain_avg_weighted_areas.push({value: avg_rain_obj.rain, weight: partial_area});
                        isobands.push(isoband);                      
                    }
                })

                var pts_tags = turf.tag(pts, rainFeature,'ID','rain');
                var avg_rain = _.meanBy(pts_tags.features, function(o){ return o.properties.rain });
                rain_avg_weighted_points.push({value: avg_rain, weight: pts_tags.features.length});
            }
        });

        const avg_rain_areas  = this.calculateAvgByWeight(rain_avg_weighted_areas);
        const avg_rain_points = this.calculateAvgByWeight(rain_avg_weighted_points);
        //Return calculated Weighted By {Point,Area}
        //return (weighted_by == 'points') ? avg_rain_points : avg_rain_areas;
        //let rainfall_avg = (weighted_by == 'points') ? avg_rain_points : avg_rain_areas;
        return {avg_areas: avg_rain_areas, avg_points: avg_rain_points, bands: isobands};
    },

    /**
     * Method to calculate average by weight
     */
    calculateAvgByWeight(values){
        var total_weight = _.sumBy(values, function(o){ return o.weight });
        if (!Number.isFinite(total_weight) || total_weight <= 0) return null;
        var aux_vals = [];

        //$.each(values, function(k,v){
        _.each(values, function(v){
            aux_vals.push(v.value * v.weight);
        });

        return _.sum(aux_vals)/total_weight;
    },

    /**
     * Method to calculate PluriAnual Discharge
     * @abstract: Through studies carried out by DAEE in 1983, it was found that multi-annual average discharge, in a given section of
     * a water course, can ge obtained with a good aproximation, through a linear relationship of this flow() with the average
     * annual precipitation in the basin hydrographic
     * @returns avg_discharge_year in m³/s
     * @param {float} coef_a
     * @param {float} coef_b
     * @param {float} avg_rainfall
     * @param {float} area 
     */
    calculateAvgFlowRateLongPeriod(coef_a, coef_b, avg_rainfall, area){
        var ret = ((coef_a+(coef_b*avg_rainfall))*area)/1000;
        console.log("Qavg(m³/s): a:",coef_a,", b:",coef_b,", p:",avg_rainfall,", area:",area," =>>> Result: ", ret);
        return ret;
    },

    /**
     * Method to calculate Q95 Discharge using DAEE Regionalization Values
     * @param {String} region {a..u}
     * @param {float} QlsM3s
     * @param {int} freqIndex {0..15}
     */
    calculateQ95(region, qls_m3s, freqIndex=14){
        var qfs = this.getPermanenceCurvesByRegionFreqIndex(region, freqIndex);
        console.log("Permanence Curve ["+region+"]["+freqIndex+"] => "+qfs);
        var ret = qfs * qls_m3s;
        return ret;
    },

    /**
     * Method to calculate minimal discharge
     * @param {*} region 
     * @param {*} time 
     * @param {*} coef_a 
     * @param {*} coef_b 
     * @param {*} qls_m3s 
     * @param {*} dmonth 
     * @returns 
     */
    calculateQmin(region, time, coef_a, coef_b, qls_m3s, dmonth){
        var xt = this.getXTCoef(region, time);
        var ret = xt * (coef_a + coef_b * dmonth) * qls_m3s;
        return ret;
    },

    /**
     * Method to calculate Q7,T Minimal Discharges
     * @param {*} coef_c 
     * @param {*} region 
     * @param {*} t 
     * @param {*} val_a,
     * @param {*} val_b,
     * @param {*} qgs_m3s
     */
    calculateQ7T(coef_c, region, t, val_a, val_b, qls_m3s){
        var xt  = this.getXTCoef(region, t);

        console.log("XT Getted: ", xt);

        console.log("Coef.C: ", coef_c);
        console.log("Val.a: ", val_a);
        console.log("Val.b: ", val_b);
        console.log("Qls: ", qls_m3s);

        var ret = coef_c * xt * (val_a + val_b) * qls_m3s;

        console.log("Q7,"+return_periods[t]+" => "+ret);
        return ret;
    },

    /**
     * Method to calculate Max Volume to Regularization
     * @param {*} qf Firm discharge
     * @param {*} region Region A..U
     * @param {*} t Return Time
     * @param {*} coef_a Coef A
     * @param {*} coef_b Coef B
     * @param {*} qls_m3s Plurianual Discharge
     * @param {*} d_months Qtd.Months to multiply seconds in month
     * @returns 
     */
    calculateVolumeRegularization(qf,region,t, coef_a, coef_b, qls_m3s, d_months=1){
        var xt = this.getXTCoef(region,t);
        console.log("Coef XT: ", xt);
        var ret = (Math.pow((qf-(xt*coef_a*qls_m3s)), 2)/(4*xt*coef_b*qls_m3s))*(d_months * K);
        console.log("Max.Vol.Regularization: "+ret);
        return ret;
    },

    /**
     * Method to calculate critical duration
     * @param {*} qf Firm discharge
     * @param {*} region Region A..U
     * @param {*} t Return Period
     * @param {*} coef_a Coef A
     * @param {*} coef_b Coef B
     * @param {*} qls_m3s Plurianual Discharge
     * @returns 
     */
    calculateCriticalDuration(qf,region,t,coef_a,coef_b,qls_m3s){
        var xt = this.getXTCoef(region,t);
        var ret = (qf-(xt*coef_a*qls_m3s))/(2*xt*coef_b*qls_m3s);
        console.log("Critical.Duration: "+ret);
        return ret;
    },


    /**
     * Method to Get Coorelation By Rain To Flow Rate
     * @param {String} region {A..U}
     */
    getRelationRainToFlowRate(region){
        var regions_rain = {
    
        //I - Region
        a: {param_a: -22.14, param_b: 0.0292},
        d: {param_a: -22.14, param_b: 0.0292},
        e: {param_a: -22.14, param_b: 0.0292},
        f: {param_a: -22.14, param_b: 0.0292},
        
        //II - Region
        b: {param_a: -29.47, param_b: 0.0315},
        c: {param_a: -29.47, param_b: 0.0315},
        h: {param_a: -29.47, param_b: 0.0315},
        i: {param_a: -29.47, param_b: 0.0315},
        j: {param_a: -29.47, param_b: 0.0315},
    
        //III - Region
        g: {param_a: -26.23, param_b: 0.0278},
        k: {param_a: -26.23, param_b: 0.0278},
        l: {param_a: -26.23, param_b: 0.0278},
        n: {param_a: -26.23, param_b: 0.0278},
        o: {param_a: -26.23, param_b: 0.0278},
        p: {param_a: -26.23, param_b: 0.0278},
        
        //IV - Region
        q: {param_a: -4.62, param_b: 0.0098},
        m: {param_a: -4.62, param_b: 0.0098},
        r: {param_a: -4.62, param_b: 0.0098},
        s: {param_a: -4.62, param_b: 0.0098},
        t: {param_a: -4.62, param_b: 0.0098},
        u: {param_a: -4.62, param_b: 0.0098}
        }
    
        return regions_rain[region.toLowerCase()];
    
    },

    /**
     * Method to Get XT Mean Coeficients by Regions Coeficients
     * @param {*} regions 
     * @param {*} time 
     */
    getXTCoefByRegions(regions, time){
        var rets = [];

        var regions = {
      
            //Region R
            a: [0.708, 0.674, 0.655, 0.641, 0.607, 0.581],
            b: [0.708, 0.674, 0.655, 0.641, 0.607, 0.581],
            d: [0.708, 0.674, 0.655, 0.641, 0.607, 0.581],
            e: [0.708, 0.674, 0.655, 0.641, 0.607, 0.581],
            f: [0.708, 0.674, 0.655, 0.641, 0.607, 0.581],
            i: [0.708, 0.674, 0.655, 0.641, 0.607, 0.581],
            j: [0.708, 0.674, 0.655, 0.641, 0.607, 0.581],
        
            //Region S
            c: [0.748, 0.723, 0.708, 0.698, 0.673, 0.656],
            h: [0.748, 0.723, 0.708, 0.698, 0.673, 0.656],
        
            //Region T
            g: [0.632, 0.588, 0.561, 0.543, 0.496, 0.461],
        
            //REgion V
            k: [0.689, 0.658, 0.639, 0.626, 0.595, 0.572],
            n: [0.689, 0.658, 0.639, 0.626, 0.595, 0.572],
            o: [0.689, 0.658, 0.639, 0.626, 0.595, 0.572],
        
            //Region U
            l: [0.759, 0.733, 0.717, 0.706, 0.677, 0.654],
            m: [0.759, 0.733, 0.717, 0.706, 0.677, 0.654],
        
            //Region W
            p: [0.619, 0.577, 0.552, 0.535, 0.426, 0.459],
        
            //Region X
            q: [0.633, 0.572, 0.533, 0.504, 0.426, 0.358],
        
            //Region Y
            r: [0.661, 0.629, 0.610, 0.598, 0.568, 0.546],
            s: [0.661, 0.629, 0.610, 0.598, 0.568, 0.546],
            t: [0.661, 0.629, 0.610, 0.598, 0.568, 0.546],   
            
            //Region z  
            u: [0.594, 0.518, 0.469, 0.433, 0.330, 0.240]
          }

        _.each(regions, function(values){
            rets.push(values[time]);
        });

        return _.mean(rets);
    },

    /**
     * Method to Get XT Coeficient by Regionalization Table
     * @param {String} regions
     * @param {Int} time {10,15,20,25,50,100}
     */
    getXTCoef(region, time){
        var regions = {
      
            //Region R
            a: [0.708, 0.674, 0.655, 0.641, 0.607, 0.581],
            b: [0.708, 0.674, 0.655, 0.641, 0.607, 0.581],
            d: [0.708, 0.674, 0.655, 0.641, 0.607, 0.581],
            e: [0.708, 0.674, 0.655, 0.641, 0.607, 0.581],
            f: [0.708, 0.674, 0.655, 0.641, 0.607, 0.581],
            i: [0.708, 0.674, 0.655, 0.641, 0.607, 0.581],
            j: [0.708, 0.674, 0.655, 0.641, 0.607, 0.581],
        
            //Region S
            c: [0.748, 0.723, 0.708, 0.698, 0.673, 0.656],
            h: [0.748, 0.723, 0.708, 0.698, 0.673, 0.656],
        
            //Region T
            g: [0.632, 0.588, 0.561, 0.543, 0.496, 0.461],
        
            //REgion V
            k: [0.689, 0.658, 0.639, 0.626, 0.595, 0.572],
            n: [0.689, 0.658, 0.639, 0.626, 0.595, 0.572],
            o: [0.689, 0.658, 0.639, 0.626, 0.595, 0.572],
        
            //Region U
            l: [0.759, 0.733, 0.717, 0.706, 0.677, 0.654],
            m: [0.759, 0.733, 0.717, 0.706, 0.677, 0.654],
        
            //Region W
            p: [0.619, 0.577, 0.552, 0.535, 0.426, 0.459],
        
            //Region X
            q: [0.633, 0.572, 0.533, 0.504, 0.426, 0.358],
        
            //Region Y
            r: [0.661, 0.629, 0.610, 0.598, 0.568, 0.546],
            s: [0.661, 0.629, 0.610, 0.598, 0.568, 0.546],
            t: [0.661, 0.629, 0.610, 0.598, 0.568, 0.546],   
            
            //Region z  
            u: [0.594, 0.518, 0.469, 0.433, 0.330, 0.240]
          }

        var normalizedRegion = String(region || '').toLowerCase();
        var periodIndex = Number(time);
        if (!regions[normalizedRegion] || !Number.isInteger(periodIndex) || periodIndex < 0 || periodIndex >= return_periods.length) {
            throw new RangeError('Invalid region or return period index');
        }
        var ret = regions[normalizedRegion][periodIndex];
        console.log("Get XT Region=",region,", T=",return_periods[time]," => ", ret);
        return ret;
    },

    /**
     * Method to Get Means of Coefs (A,B)
     * @param {String} region
     */
    getMeansABCoef(region){

        //console.log("Try find Region Means AB => Region ", r);
        var regions = {
          a: {a: 0.3532, b: 0.0398},
          b: {a: 0.4174, b: 0.0426},
          c: {a: 0.4174, b: 0.0426},
          d: {a: 0.5734, b: 0.0329},
          e: {a: 0.4775, b: 0.0330},
          f: {a: 0.6434, b: 0.0252},
          g: {a: 0.4089, b: 0.0332},
          h: {a: 0.4951, b: 0.0279},
          i: {a: 0.6276, b: 0.0283},
          j: {a: 0.4741, b: 0.0342},
          k: {a: 0.4951, b: 0.0279},
          l: {a: 0.6537, b: 0.0267},
          m: {a: 0.6141, b: 0.0257},
          n: {a: 0.4119, b: 0.0295},
          o: {a: 0.3599, b: 0.0312},
          p: {a: 0.3599, b: 0.0312},
          q: {a: 0.6537, b: 0.0267},
          r: {a: 0.6141, b: 0.0257},
          s: {a: 0.5218, b: 0.0284},
          t: {a: 0.4119, b: 0.0295},
          u: {a: 0.4119, b: 0.0295}
      
        }
      
        return regions[region.toLowerCase()];
    },

    /**
     * Method to Get Permanence Curves Values By Region Letter (A..U)
     * @param {String} region {a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,r,s,t,u}
     */
    getPermanenceCurvesByRegion(region){
        var regions = {
            a: [2.608, 2.045, 1.618, 1.325, 1.165, 1.093, 0.950, 0.810, 0.693, 0.590, 0.535, 0.408, 0.443, 0.393, 0.348, 0.260],
            b: [2.150, 1.734, 1.505, 1.366, 1.250, 1.153, 0.994, 0.946, 0.745, 0.640, 0.588, 0.545, 0.498, 0.430, 0.371, 0.165],
            c: [2.150, 1.734, 1.505, 1.366, 1.250, 1.153, 0.994, 0.946, 0.745, 0.640, 0.588, 0.545, 0.498, 0.430, 0.371, 0.165],
            d: [1.947, 1.597, 1.394, 1.271, 1.193, 1.111, 0.996, 0.897, 0.820, 0.727, 0.687, 0.646, 0.607, 0.560, 0.510, 0.423],
            e: [2.142, 1.676, 1.496, 1.372, 1.278, 1.160, 0.960, 0.834, 0.744, 0.664, 0.626, 0.580, 0.546, 0.504, 0.440, 0.358],
            f: [1.797, 1.533, 1.400, 1.297, 1.232, 1.165, 1.003, 0.905, 0.822, 0.743, 0.715, 0.672, 0.643, 0.598, 0.558, 0.465],
            g: [2.396, 1.983, 1.664, 1.442, 1.255, 1.121, 0.923, 0.789, 0.679, 0.592, 0.547, 0.506, 0.469, 0.420, 0.363, 0.223],
            h: [2.089, 1.788, 1.579, 1.389, 1.239, 1.118, 0.957, 0.845, 0.750, 0.664, 0.627, 0.590, 0.538, 0.490, 0.434, 0.324],
            i: [1.913, 1.538, 1.365, 1.270, 1.173, 1.103, 0.923, 0.789, 0.679, 0.592, 0.547, 0.506, 0.469, 0.420, 0.363, 0.223],
            j: [2.272, 1.792, 1.526, 1.366, 1.231, 1.125, 0.948, 0.807, 0.715, 0.628, 0.596, 0.566, 0.523, 0.462, 0.414, 0.288],
            k: [2.089, 1.788, 1.579, 1.389, 1.239, 1.118, 0.957, 0.845, 0.750, 0.664, 0.627, 0.590, 0.538, 0.490, 0.434, 0.324],
            l: [1.770, 1.517, 1.390, 1.310, 1.225, 1.158, 1.012, 0.915, 0.827, 0.748, 0.717, 0.667, 0.628, 0.583, 0.527, 0.420],
            m: [1.970, 1.666, 1.468, 1.294, 1.181, 1.096, 0.961, 0.874, 0.790, 0.714, 0.679, 0.646, 0.604, 0.570, 0.516, 0.429],
            n: [2.396, 1.983, 1.664, 1.442, 1.255, 1.121, 0.923, 0.789, 0.679, 0.592, 0.547, 0.506, 0.469, 0.420, 0.363, 0.223],
            o: [2.408, 2.010, 1.750, 1.538, 1.346, 1.179, 0.935, 0.775, 0.645, 0.547, 0.505, 0.462, 0.418, 0.374, 0.316, 0.170],
            p: [2.408, 2.010, 1.750, 1.538, 1.346, 1.179, 0.935, 0.775, 0.645, 0.547, 0.505, 0.462, 0.418, 0.374, 0.316, 0.170],
            q: [1.770, 1.517, 1.390, 1.310, 1.225, 1.158, 1.012, 0.915, 0.827, 0.748, 0.717, 0.667, 0.628, 0.583, 0.527, 0.420],
            r: [1.940, 1.640, 1.453, 1.320, 1.203, 1.113, 0.967, 0.873, 0.803, 0.713, 0.670, 0.627, 0.577, 0.527, 0.463, 0.340],
            s: [2.325, 1.823, 1.588, 1.352, 1.188, 1.097, 0.925, 0.810, 0.708, 0.633, 0.598, 0.563, 0.525, 0.488, 0.420, 0.293],
            t: [2.471, 2.156, 1.751, 1.468, 1.324, 1.109, 0.880, 0.781, 0.674, 0.581, 0.517, 0.481, 0.429, 0.380, 0.316, 0.240],
            u: [2.471, 2.156, 1.751, 1.468, 1.324, 1.109, 0.880, 0.781, 0.674, 0.581, 0.517, 0.481, 0.429, 0.380, 0.319, 0.241]
        };
    
        return regions[region.toLowerCase()];
    },

    /**
     * Method to Get Permanence Curves Using Region and Index
     * @param {String} region {a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,r,s,t,u}
     * @param {int} freqIndex {p5=0,p10=1,p15=2,p20=3,p25=4,p30=5,p40=6,p50=7,p60=8,p70=9,p80=10,p85=11,p90=12,p95=13,p100=14}
     */
    getPermanenceCurvesByRegionFreqIndex(region,freqIndex){
        return this.getPermanenceCurvesByRegion(region)[freqIndex];
    },

    /**
     * Method to Get Elevation by Mapbox Service
     */
    async getElevationByCoords(lat,lon){
        var token = process.env.MAPBOX_TOKEN;
        if (!token || typeof fetch !== 'function') return null;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);
        let query;
        try {
            query = await fetch(
                `https://api.mapbox.com/v4/mapbox.mapbox-terrain-v2/tilequery/${lon},${lat}.json?layers=contour&limit=50&access_token=${token}`,
                { method: 'GET', signal: controller.signal }
            );
        } catch (error) {
            return null;
        } finally {
            clearTimeout(timeout);
        }

        if (!query.ok) return null;
    
        const data = await query.json();
        // Get all the returned features.
        const allFeatures = data.features;
        //console.log(allFeatures);
        // For each returned feature, add elevation data to the elevations array.
        const elevations = allFeatures
            .map((feature) => Number(feature.properties.ele))
            .filter(Number.isFinite);
        if (elevations.length === 0) return null;
        //console.log(elevations);
        // In the elevations array, find the largest value.
        const highestElevation = Math.max(...elevations);
        const lowestElevation  = Math.min(...elevations);

        return {min: lowestElevation, max: highestElevation};
    }
}

module.exports = regflow;
