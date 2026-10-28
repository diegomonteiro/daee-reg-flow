import tempfile
import unittest
from pathlib import Path
import numpy as np
import rasterio
from rasterio.transform import from_origin
from pyproj import Transformer
from shapely.geometry import box,mapping,shape
from shapely.ops import transform,unary_union
from microbasins import partition,delineate_microbasins

class MicrobasinTests(unittest.TestCase):
    def test_confluence_partition_is_disjoint_and_keeps_residuals_separate(self):
        flow=np.zeros((5,5),dtype='uint8');valid=np.zeros((5,5),dtype=bool);acc=np.zeros((5,5))
        for row,col,code,a in [(0,0,0,1),(0,1,4,1),(0,3,4,1),(1,1,2,2),(1,3,8,2),(2,2,4,5),(3,2,4,6),(4,2,0,7)]:
            flow[row,col]=code;valid[row,col]=True;acc[row,col]=a
        labels,units=partition(flow,valid,acc,2)
        self.assertEqual(sum(p['kind']=='stream_reach' for p in units.values()),3)
        self.assertEqual(sum(p['kind']=='residual_outlet' for p in units.values()),1)
        self.assertTrue((labels[valid]>0).all())
        self.assertEqual(labels[0,1],labels[1,1]);self.assertNotEqual(labels[1,1],labels[1,3])
        self.assertNotEqual(labels[1,1],labels[2,2])
        self.assertEqual(units[int(labels[1,1])]['downstream_unit_id'],int(labels[2,2]))
        np.testing.assert_array_equal(labels,partition(flow,valid,acc,2)[0])

    def test_cycles_are_rejected(self):
        with self.assertRaisesRegex(ValueError,'Ciclo'):
            partition(np.array([[1,16]]),np.ones((1,2),dtype=bool),np.ones((1,2))*10,2)

    def test_hillslope_cycles_are_rejected_even_with_valid_channels_elsewhere(self):
        with self.assertRaisesRegex(ValueError,'Ciclo'):
            partition(np.array([[1,16],[1,0]]),np.ones((2,2),dtype=bool),np.array([[1,1],[10,20]]),2)

    def test_cycles_with_tributaries_are_rejected_before_labelling(self):
        for flow in ([[1, 1, 16]], [[1, 1, 4], [0, 64, 16]]):
            with self.subTest(flow=flow):
                array = np.array(flow, dtype='uint8')
                with self.assertRaisesRegex(ValueError, 'Ciclo'):
                    partition(array, np.ones(array.shape, dtype=bool), np.full(array.shape, 10), 2)

    def test_threshold_without_channels_is_rejected(self):
        with self.assertRaisesRegex(ValueError,'Nenhuma drenagem'):
            partition(np.array([[0]]),np.ones((1,1),dtype=bool),np.ones((1,1)),2)

    def test_final_context_dissolves_adjacent_ottobasins_and_respects_point_cut(self):
        with tempfile.TemporaryDirectory() as directory:
            affine = from_origin(300000, 7400000, 30, 30)
            paths = [Path(directory)/'flow.tif', Path(directory)/'acc.tif']
            values = [np.full((4, 4), 4, dtype='float32'), np.tile(np.arange(1, 5, dtype='float32')[:, None], (1, 4))]
            for path, data in zip(paths, values):
                with rasterio.open(path, 'w', driver='GTiff', height=4, width=4, count=1, dtype='float32', crs='EPSG:31983', transform=affine, nodata=-9999) as dst:
                    dst.write(data, 1)
            backward = Transformer.from_crs(31983, 4326, always_xy=True).transform
            # Adjacent upstream and downstream polygons; the lowest raster row
            # is below the selected point and must not reappear in microbasins.
            upstream = transform(backward, box(300000.01, 7399940, 300119.99, 7399999.99))
            downstream = transform(backward, box(300000.01, 7399910.01, 300119.99, 7399940))
            geometry = {'type': 'MultiPolygon', 'coordinates': [mapping(upstream)['coordinates'], mapping(downstream)['coordinates']]}
            request = {'basin': {'properties': {'COBACIA': 'downstream'}, 'geometry': geometry},
                       'scope': 'calculated_basin', 'min_drainage_area_km2': .0018}
            result = delineate_microbasins(request, *paths)
            self.assertEqual(result['metadata']['scope'], 'calculated_basin')
            self.assertEqual(result['metadata']['valid_cells'], 12)
            self.assertEqual(result['metadata']['classified_cells'], 12)
            self.assertEqual(result['metadata']['microbasins_count'], 4)
            self.assertTrue(all(f['properties']['cell_count'] == 3 for f in result['features']))
            self.assertTrue(all(f['geometry']['type'] in ('Polygon', 'MultiPolygon') for f in result['features']))
            polygons = [shape(f['geometry']) for f in result['features']]
            expected = unary_union([upstream, downstream])
            output = unary_union(polygons)
            self.assertAlmostEqual(sum(p.area for p in polygons), output.area, places=12)
            self.assertLess(output.difference(expected).area, 1e-12)
            self.assertAlmostEqual(output.area, expected.area, places=12)

    def test_geotiff_partition_covers_cells_without_polygon_overlap(self):
        with tempfile.TemporaryDirectory() as directory:
            affine=from_origin(300000,7400000,30,30)
            paths=[Path(directory)/'flow.tif',Path(directory)/'acc.tif']
            values=[np.full((4,4),4,dtype='float32'),np.tile(np.arange(1,5,dtype='float32')[:,None],(1,4))]
            for path,data in zip(paths,values):
                with rasterio.open(path,'w',driver='GTiff',height=4,width=4,count=1,dtype='float32',crs='EPSG:31983',transform=affine,nodata=-9999) as dst:dst.write(data,1)
            backward=Transformer.from_crs(31983,4326,always_xy=True).transform
            basin=transform(backward,box(300000.01,7399880.01,300119.99,7399999.99))
            request={'basin':{'properties':{'COBACIA':'test'},'geometry':mapping(basin)},'min_drainage_area_km2':0.0018}
            result=delineate_microbasins(request,*paths)
            self.assertEqual(result['metadata']['classified_cells'],16)
            self.assertEqual(result['metadata']['microbasins_count'],4)
            polygons=[shape(f['geometry']) for f in result['features']]
            self.assertAlmostEqual(sum(p.area for p in polygons),unary_union(polygons).area,places=12)
            self.assertAlmostEqual(unary_union(polygons).area,basin.area,places=12)
            with rasterio.open(paths[0],'r+') as dst:
                data=dst.read(1);data[1,1]=-9999;dst.write(data,1)
            with self.assertRaisesRegex(ValueError,'NoData'):delineate_microbasins(request,*paths)

if __name__=='__main__':unittest.main()
