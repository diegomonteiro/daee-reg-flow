"""Bounded PNG visualization of the exact elevation grid used to prepare D8."""
import base64
import json
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.features import geometry_mask
from rasterio.io import MemoryFile
from rasterio.transform import from_bounds
from rasterio.warp import reproject, transform_geom, transform_bounds
from rasterio.windows import from_bounds as window_from_bounds, Window
from shapely.geometry import mapping, shape
from shapely import make_valid
from shapely.ops import unary_union
from shapely.errors import GEOSException
from pyproj import Transformer

# Low -> high, shared with the browser legend.
COLORS = ['#0c6671', '#4f9974', '#d6ca8a', '#a56f47', '#f3eee0']


def extract_contours(values, affine, crs, basin):
    """GDAL contours of bounded display samples, clipped in the source metric CRS."""
    features = []
    to_wgs84 = Transformer.from_crs(crs, 'EPSG:4326', always_xy=True)
    tolerance = min(abs(affine.a), abs(affine.e)) * 0.1
    nodata = -999999.0
    with tempfile.TemporaryDirectory(prefix='regflow-contours-') as directory:
        raster, vector = Path(directory)/'display.tif', Path(directory)/'contours.geojson'
        with rasterio.open(raster, 'w', driver='GTiff', width=values.shape[1], height=values.shape[0],
                           count=1, dtype='float32', crs=crs, transform=affine, nodata=nodata) as dst:
            dst.write(np.where(np.isfinite(values), values, nodata).astype('float32'), 1)
        subprocess.run(['gdal_contour', '-q', '-i', '10', '-a', 'elevation_m', '-f', 'GeoJSON',
                        str(raster), str(vector)], check=True, capture_output=True, timeout=3)
        collection = json.loads(vector.read_text())
        for feature in collection['features']:
            clipped = shape(feature['geometry']).simplify(tolerance, preserve_topology=True).intersection(basin)
            # Intersection can create a collection at tangential boundary contacts.
            parts = list(clipped.geoms) if hasattr(clipped, 'geoms') else [clipped]
            for line in parts:
                if line.is_empty or line.geom_type != 'LineString' or line.length == 0:
                    continue
                level = int(round(feature['properties']['elevation_m']))
                coordinates = np.asarray(line.coords)
                lon, lat = to_wgs84.transform(coordinates[:, 0], coordinates[:, 1])
                features.append({'type': 'Feature', 'properties': {'elevation_m': level, 'major': level % 50 == 0},
                                 'geometry': {'type': 'LineString', 'coordinates': np.column_stack((lon, lat)).tolist()}})
    return {'type': 'FeatureCollection', 'features': features}


def polygonal_union(geometry):
    """Dissolve adjacent upstream polygons; retain polygonal components and holes."""
    polygons = []
    def collect(part):
        if part.geom_type == 'Polygon':
            if not part.is_valid:
                collect(make_valid(part))
            elif not part.is_empty:
                polygons.append(part)
        elif hasattr(part, 'geoms'):
            for child in part.geoms:
                collect(child)
    collect(geometry)
    result = unary_union(polygons)
    if result.is_empty:
        raise ValueError('Área final vazia para visualizar topografia.')
    return result


def render_topography(elevation_path, flow_source, basin, max_size=512, scope='clicked_ottobasin'):
    """Clip to the supplied geometry; only display samples are resampled."""
    basin = polygonal_union(basin)
    with rasterio.open(elevation_path) as elevation:
        if (elevation.crs != flow_source.crs or not elevation.transform.almost_equals(flow_source.transform, precision=1e-7)
                or elevation.shape != flow_source.shape):
            raise ValueError('Grade do MDE de elevação incompatível com o raster D8.')
        raw = window_from_bounds(*basin.bounds, transform=elevation.transform)
        c0, r0 = max(0, int(np.floor(raw.col_off))), max(0, int(np.floor(raw.row_off)))
        c1 = min(elevation.width, int(np.ceil(raw.col_off + raw.width)))
        r1 = min(elevation.height, int(np.ceil(raw.row_off + raw.height)))
        if c1 <= c0 or r1 <= r0:
            raise ValueError('MDE sem cobertura da área final.')
        window = Window(c0, r0, c1-c0, r1-r0)
        factor = min(1.0, max_size / max(window.width, window.height))
        read_width = max(1, int(np.ceil(window.width * factor)))
        read_height = max(1, int(np.ceil(window.height * factor)))
        values = elevation.read(1, window=window, out_shape=(read_height, read_width),
                                masked=True, resampling=Resampling.bilinear).astype('float32').filled(np.nan)
        read_transform = elevation.window_transform(window) * rasterio.Affine.scale(
            window.width / read_width, window.height / read_height)
        mercator_basin = transform_geom(elevation.crs, 'EPSG:3857', mapping(basin))
        # A north-up Web Mercator image is required for correct Leaflet alignment.
        left, bottom, right, top = transform_bounds(elevation.crs, 'EPSG:3857', *basin.bounds, densify_pts=21)
        factor = max_size / max(right-left, top-bottom)
        width, height = max(1, min(max_size, int(np.ceil((right-left)*factor)))), max(1, min(max_size, int(np.ceil((top-bottom)*factor))))
        target_transform = from_bounds(left, bottom, right, top, width, height)
        target = np.full((height, width), np.nan, dtype='float32')
        reproject(source=values, destination=target, src_transform=read_transform,
                  src_crs=elevation.crs, src_nodata=np.nan, dst_transform=target_transform,
                  dst_crs='EPSG:3857', dst_nodata=np.nan, resampling=Resampling.bilinear)
        visible = geometry_mask([mercator_basin], target.shape, target_transform, invert=True)
        visible &= np.isfinite(target)
        if not visible.any():
            raise ValueError('MDE sem cotas válidas para visualizar nesta área.')
        low, high = float(target[visible].min()), float(target[visible].max())
        normalized = np.zeros(target.shape, dtype='float32')
        if high > low:
            normalized[visible] = (target[visible] - low) / (high-low)
        stops = np.linspace(0, 1, len(COLORS))
        ramp = np.array([[int(color[i:i+2], 16) for i in (1, 3, 5)] for color in COLORS])
        rgba = np.zeros((4, height, width), dtype='uint8')
        for channel in range(3):
            rgba[channel] = np.interp(normalized, stops, ramp[:, channel]).astype('uint8')
        rgba[3] = visible.astype('uint8') * 255
        with MemoryFile() as memory:
            with memory.open(driver='PNG', count=4, dtype='uint8', width=width, height=height) as png:
                png.write(rgba)
            encoded = base64.b64encode(memory.read()).decode('ascii')
        west, south, east, north = transform_bounds('EPSG:3857', 'EPSG:4326', left, bottom, right, top)
        contours, contours_warning = None, None
        try:
            contours = extract_contours(values, read_transform, elevation.crs, basin)
        except (OSError, subprocess.SubprocessError, ValueError) as error:
            contours_warning = 'Curvas de nível indisponíveis: verifique gdal_contour e o limite de processamento.'
        return {'contours': contours, 'contours_warning': contours_warning,
                'contour_interval_m': 10, 'contour_major_interval_m': 50,
                'contour_sample_resolution_m': [abs(read_transform.a), abs(read_transform.e)],
                'image': 'data:image/png;base64,' + encoded,
                'bounds': [[south, west], [north, east]], 'width': width, 'height': height,
                'display_min': low, 'display_max': high, 'colors': COLORS,
                'source_resolution_m': [abs(elevation.transform.a), abs(elevation.transform.e)],
                'scope': scope, 'source': 'prepared_elevation',
                'display_crs': 'EPSG:3857', 'elevation_unit': 'source'}


if __name__ == '__main__':
    import json
    import sys
    from shapely.geometry import shape
    try:
        request = json.load(sys.stdin)
        with rasterio.open(sys.argv[1]) as elevation, rasterio.open(sys.argv[2] if len(sys.argv) > 2 else sys.argv[1]) as flow:
            if not elevation.crs or not elevation.crs.is_projected or elevation.crs.linear_units != 'metre':
                raise ValueError('O MDE para exibição deve usar CRS projetado em metros.')
            basin = shape(transform_geom('EPSG:4326', elevation.crs, request['basin']['geometry']))
            image = render_topography(sys.argv[1], flow, basin, scope=request.get('scope', 'calculated_basin'))
        print(json.dumps({'topography': image, 'topography_warning': None}, allow_nan=False))
    except (ValueError, rasterio.errors.RasterioError, GEOSException) as error:
        print(json.dumps({'error': str(error)}))
