import tempfile
import unittest
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_origin
from pyproj import Transformer
from shapely.geometry import box, mapping, shape, LineString
from shapely.ops import transform
from delineate import delineate, upstream_mask


class DelineationTests(unittest.TestCase):
    def test_reverse_d8_uses_flow_not_a_straight_cut(self):
        flow = np.array([[2, 4, 8], [1, 4, 16], [1, 0, 16]])
        selected = upstream_mask(flow, np.ones((3, 3), dtype=bool), (1, 1))
        np.testing.assert_array_equal(selected, [[True, True, True], [True, True, True], [False, False, False]])

    def test_all_eight_esri_directions_point_to_the_same_outlet(self):
        flow = np.array([[2, 4, 8], [1, 0, 16], [128, 64, 32]], dtype='uint8')
        np.testing.assert_array_equal(upstream_mask(flow, np.ones((3, 3), dtype=bool), (1, 1)),
                                      np.ones((3, 3), dtype=bool))

    def test_mask_prevents_crossing_authoritative_boundary(self):
        flow = np.array([[1, 1, 0]])
        valid = np.array([[True, False, True]])
        np.testing.assert_array_equal(upstream_mask(flow, valid, (0, 2)), [[False, False, True]])

    def fixture(self, directory, nodata=False):
        affine = from_origin(300000, 7400000, 30, 30)
        paths = [Path(directory)/'flow.tif', Path(directory)/'acc.tif']
        data = [np.full((5, 5), 4, dtype='float32'), np.tile(np.arange(1, 6, dtype='float32')[:, None], (1, 5))]
        if nodata:
            data[0][0, 0] = -9999
        for path, values in zip(paths, data):
            with rasterio.open(path, 'w', driver='GTiff', height=5, width=5, count=1,
                               dtype='float32', crs='EPSG:31983', transform=affine, nodata=-9999) as dst:
                dst.write(values, 1)
        backward = Transformer.from_crs('EPSG:31983', 'EPSG:4326', always_xy=True).transform
        # Inset avoids round-trip floating point bounds stepping beyond the raster.
        basin = transform(backward, box(300000.01, 7399850.01, 300149.99, 7399999.99))
        request = {'basin': {'type': 'Feature', 'properties': {'COBACIA': 'test'}, 'geometry': mapping(basin)},
                   'point': list(backward(300075, 7399925)), 'min_drainage_area_km2': 0.0009,
                   'streams': [{'type': 'Feature', 'geometry': mapping(transform(backward, LineString([(300075,7399851),(300075,7399999)])))}]}
        return request, paths

    def test_geotiff_window_polygon_and_internal_divide(self):
        with tempfile.TemporaryDirectory() as directory:
            request, paths = self.fixture(directory)
            result = delineate(request, *paths)
            self.assertEqual(result['cell_count'], 3)
            self.assertLessEqual(result['snap_distance_m'], 1)
            self.assertTrue(shape(result['contributing_area']['geometry']).is_valid)
            self.assertIsNotNone(result['divide'])
            self.assertGreater(result['area_km2'], 0)

    def test_whole_basin_returns_no_internal_divide(self):
        with tempfile.TemporaryDirectory() as directory:
            request, paths = self.fixture(directory)
            flow = np.ones((5, 5), dtype='float32')
            flow[:, -1] = 4
            flow[-1, -1] = 0
            with rasterio.open(paths[0], 'r+') as dst:
                dst.write(flow, 1)
            backward = Transformer.from_crs('EPSG:31983', 'EPSG:4326', always_xy=True).transform
            request['point'] = list(backward(300135, 7399865))
            request['streams'] = [{'geometry': mapping(transform(backward, LineString([(300135,7399851),(300135,7399999)])))}]
            result = delineate(request, *paths)
            self.assertEqual(result['cell_count'], 25)
            self.assertIsNone(result['divide'])

    def test_missing_visual_elevation_does_not_invalidate_delineation(self):
        with tempfile.TemporaryDirectory() as directory:
            request, paths = self.fixture(directory)
            result = delineate(request, *paths, str(Path(directory)/'missing-elevation.tif'))
            self.assertEqual(result['cell_count'], 3)
            self.assertIsNone(result['topography'])
            self.assertIn('indisponível', result['topography_warning'])

    def test_visual_topography_can_be_disabled_without_changing_delineation(self):
        with tempfile.TemporaryDirectory() as directory:
            request, paths = self.fixture(directory)
            request['include_topography'] = False
            result = delineate(request, *paths, str(Path(directory)/'missing-elevation.tif'))
            self.assertEqual(result['cell_count'], 3)
            self.assertIsNone(result['topography'])
            self.assertIsNone(result['topography_warning'])

    def test_nodata_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            request, paths = self.fixture(directory, nodata=True)
            with self.assertRaisesRegex(ValueError, 'NoData'):
                delineate(request, *paths)

    def test_snap_has_no_radius_and_nearest_wins_over_accumulation(self):
        with tempfile.TemporaryDirectory() as directory:
            request, paths = self.fixture(directory)
            backward = Transformer.from_crs('EPSG:31983', 'EPSG:4326', always_xy=True).transform
            request['point'] = list(backward(295000, 7399985))
            result = delineate(request, *paths)
            self.assertGreater(result['snap_distance_m'], 1000)
            self.assertEqual(result['cell_count'], 1)
            self.assertAlmostEqual(result['snapped_accumulation_cells'], 1)

    def test_no_drainage_above_area_threshold_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            request, paths = self.fixture(directory)
            request['min_drainage_area_km2'] = 10
            with self.assertRaisesRegex(ValueError, 'Nenhuma célula de drenagem'):
                delineate(request, *paths)

    def test_incoming_basin_is_selected_only_if_its_d8_flow_reaches_outlet(self):
        with tempfile.TemporaryDirectory() as directory:
            request, paths = self.fixture(directory)
            backward = Transformer.from_crs('EPSG:31983', 'EPSG:4326', always_xy=True).transform
            # The local basin begins one row below the raster top; north cells flow south.
            request['basin']['geometry'] = mapping(transform(backward, box(300000.01,7399850.01,300149.99,7399969.99)))
            request['inflow_basins'] = [
                {'properties': {'COBACIA': code}, 'geometry': mapping(transform(backward, polygon))}
                for code, polygon in [('feeds', box(300060,7399970,300090,7400000)),
                                      ('other_branch', box(300000,7399970,300030,7400000))]]
            result = delineate(request, *paths)
            self.assertEqual(result['contributing_upstream_codes'], ['feeds'])


if __name__ == '__main__':
    unittest.main()
