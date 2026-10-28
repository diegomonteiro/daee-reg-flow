import base64
import tempfile
import unittest
from pathlib import Path

import numpy as np
import rasterio
from rasterio.io import MemoryFile
from rasterio.transform import from_origin
from shapely.geometry import Polygon, MultiPolygon, box
from topography import render_topography, extract_contours, polygonal_union


class TopographyTests(unittest.TestCase):
    def raster(self, path, values, affine=None):
        with rasterio.open(path, 'w', driver='GTiff', width=9, height=9, count=1,
                           crs='EPSG:31983', transform=affine or from_origin(300000,7400000,30,30),
                           dtype='float32', nodata=-9999) as dst:
            dst.write(values.astype('float32'), 1)

    def test_png_is_clipped_transparent_georeferenced_and_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)/'elevation.tif'
            values = 700 + np.arange(81).reshape(9,9)
            values[2,2] = -9999
            self.raster(source, values)
            basin = Polygon([(300001,7399731),(300269,7399731),(300001,7399999)])
            with rasterio.open(source) as flow:
                result = render_topography(source, flow, basin, max_size=64)
            self.assertLessEqual(result['width'],64)
            self.assertLessEqual(result['height'],64)
            self.assertEqual(result['display_crs'],'EPSG:3857')
            self.assertLess(result['bounds'][0][0], result['bounds'][1][0])
            self.assertLess(result['bounds'][0][1], result['bounds'][1][1])
            self.assertGreaterEqual(result['display_min'],700)
            self.assertLessEqual(result['display_max'],780)
            payload = base64.b64decode(result['image'].split(',')[1])
            self.assertEqual(payload[:8], b'\x89PNG\r\n\x1a\n')
            with MemoryFile(payload) as memory, memory.open() as png:
                rgba = png.read()
                self.assertEqual(png.count,4)
                self.assertTrue((rgba[3] == 0).any())
                self.assertTrue((rgba[3] == 255).any())

    def test_flat_terrain_does_not_divide_by_zero(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)/'elevation.tif'
            self.raster(source, np.full((9,9),700))
            basin = Polygon([(300001,7399731),(300269,7399731),(300001,7399999)])
            with rasterio.open(source) as flow:
                result = render_topography(source, flow, basin, max_size=32)
            self.assertEqual(result['display_min'],700)
            self.assertEqual(result['display_max'],700)
            self.assertEqual(result['contours']['features'], [])
            self.assertIsNone(result['contours_warning'])

    def test_contours_have_ten_metre_levels_and_fifty_metre_masters(self):
        from rasterio.warp import transform_geom
        from shapely.geometry import shape, mapping
        affine = from_origin(300000,7400000,30,30)
        values = np.tile(np.arange(9) * 10.0 + 700, (9,1))
        basin = Polygon([(300020,7399750),(300250,7399750),(300250,7399980),(300020,7399980)],
                        holes=[[(300100,7399850),(300150,7399850),(300150,7399900),(300100,7399900)]])
        result = extract_contours(values, affine, 'EPSG:31983', basin)
        self.assertTrue(result['features'])
        levels = {f['properties']['elevation_m'] for f in result['features']}
        self.assertIn(750, levels)
        self.assertIn(740, levels)
        for feature in result['features']:
            props = feature['properties']
            self.assertEqual(props['elevation_m'] % 10, 0)
            self.assertEqual(props['major'], props['elevation_m'] % 50 == 0)
            projected = shape(transform_geom('EPSG:4326', 'EPSG:31983', feature['geometry']))
            self.assertTrue(basin.buffer(.001).covers(projected))

    def test_adjacent_basins_are_dissolved_without_losing_holes_or_disconnected_parts(self):
        left = box(300000,7399740,300120,7400000)
        right = Polygon([(300120,7399740),(300240,7399740),(300240,7400000),(300120,7400000)],
                        holes=[[(300150,7399800),(300210,7399800),(300210,7399890),(300150,7399890)]])
        island = box(300250,7399740,300260,7399770)
        combined = MultiPolygon([left,right,island])
        self.assertFalse(combined.is_valid)
        result = polygonal_union(combined)
        self.assertTrue(result.is_valid)
        self.assertAlmostEqual(result.area,left.area+right.area+island.area)
        self.assertFalse(result.covers(box(300160,7399810,300200,7399880)))
        self.assertTrue(result.covers(island))
        overlapping = polygonal_union(MultiPolygon([box(0,0,2,2),box(1,0,3,2)]))
        self.assertEqual(overlapping.area,6)
        self.assertTrue(overlapping.covers(box(1,0,2,2)))

    def test_topography_and_contours_include_the_upstream_part_of_the_final_geometry(self):
        from rasterio.warp import transform_geom
        from shapely.geometry import shape
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)/'elevation.tif'
            self.raster(source,700+np.arange(81).reshape(9,9))
            left = box(300001,7399731,300120,7399999)
            upstream = box(300120,7399731,300269,7399999)
            combined = MultiPolygon([left,upstream])
            with rasterio.open(source) as flow:
                local = render_topography(source,flow,left,max_size=64)
                final = render_topography(source,flow,combined,max_size=64,scope='calculated_basin')
            self.assertEqual(final['scope'],'calculated_basin')
            self.assertGreater(final['bounds'][1][1],local['bounds'][1][1])
            self.assertIsNone(final['contours_warning'])
            lines=[shape(transform_geom('EPSG:4326','EPSG:31983',f['geometry'])) for f in final['contours']['features']]
            self.assertTrue(any(line.intersection(upstream).length>0 for line in lines))
            self.assertTrue(any(line.intersection(left).length>0 for line in lines))
            expected=polygonal_union(combined).buffer(.001)
            self.assertTrue(all(expected.covers(line) for line in lines))

    def test_different_elevation_grid_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            source, shifted = Path(directory)/'flow.tif',Path(directory)/'shifted.tif'
            self.raster(source,np.ones((9,9)))
            self.raster(shifted,np.ones((9,9)),from_origin(300015,7400000,30,30))
            basin = Polygon([(300001,7399731),(300269,7399731),(300001,7399999)])
            with rasterio.open(source) as flow:
                with self.assertRaisesRegex(ValueError,'incompatível'):
                    render_topography(shifted, flow, basin)


if __name__ == '__main__':
    unittest.main()
