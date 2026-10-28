"""Windowed delineation from aligned, preconditioned ESRI D8 and accumulation rasters."""
import json
import sys

import numpy as np
import rasterio
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import breadth_first_order
from rasterio.features import geometry_mask, shapes
from rasterio.windows import from_bounds, Window
from pyproj import Transformer
from shapely.geometry import shape, mapping, Point
from shapely.ops import transform, unary_union
from topography import render_topography

# ESRI: E, SE, S, SW, W, NW, N, NE.
DIRECTIONS = ((1, 0, 1), (2, 1, 1), (4, 1, 0), (8, 1, -1),
              (16, 0, -1), (32, -1, -1), (64, -1, 0), (128, -1, 1))


def upstream_mask(flow, valid, outlet):
    """Reverse D8 traversal, restricted to the authoritative ottobasin."""
    height, width = flow.shape
    donors = np.flatnonzero(valid)
    codes = flow.ravel()[donors].astype('uint8')
    dr_lookup = np.zeros(256, dtype='int8')
    dc_lookup = np.zeros(256, dtype='int8')
    for code, dr, dc in DIRECTIONS:
        dr_lookup[code], dc_lookup[code] = dr, dc
    rows = donors // width + dr_lookup[codes]
    cols = donors % width + dc_lookup[codes]
    keep = (codes != 0) & (rows >= 0) & (rows < height) & (cols >= 0) & (cols < width)
    donors, receivers = donors[keep], (rows[keep] * width + cols[keep])
    keep = valid.ravel()[receivers]
    donors, receivers = donors[keep], receivers[keep]
    # One downstream receiver per donor. Reverse edges let native SciPy BFS
    # enumerate the contributing cells without a Python loop per pixel.
    graph = csr_matrix((np.ones(len(donors), dtype='uint8'), (receivers, donors)),
                       shape=(flow.size, flow.size))
    order = breadth_first_order(graph, outlet[0] * width + outlet[1],
                                directed=True, return_predecessors=False)
    selected = np.zeros(flow.size, dtype=bool)
    selected[order] = True
    return selected.reshape(flow.shape)


def delineate(request, flow_path, accumulation_path, elevation_path=None):
    with rasterio.open(flow_path) as src, rasterio.open(accumulation_path) as acc:
        if (src.crs != acc.crs or src.transform != acc.transform
                or src.shape != acc.shape):
            raise ValueError('Direção D8 e acumulação devem ter CRS, grade e extensão idênticos.')
        if not src.crs or not src.crs.is_projected or src.crs.linear_units != 'metre':
            raise ValueError('Rasters devem usar CRS projetado em metros.')
        if src.transform.b != 0 or src.transform.d != 0 or src.transform.a <= 0 or src.transform.e >= 0:
            raise ValueError('Use raster norte-acima sem rotação.')
        forward = Transformer.from_crs('EPSG:4326', src.crs, always_xy=True).transform
        backward = Transformer.from_crs(src.crs, 'EPSG:4326', always_xy=True).transform
        basin = transform(forward, shape(request['basin']['geometry']))
        point = transform(forward, Point(request['point']))
        streams = unary_union([transform(forward, shape(feature['geometry'])) for feature in request.get('streams', [])])
        if streams.is_empty:
            raise ValueError('Ottobacia sem drenagem oficial para validar o ajuste do exutório.')
        stream_tolerance = 2 * max(src.transform.a, -src.transform.e)
        raw = from_bounds(*basin.bounds, transform=src.transform)
        c0, r0 = int(np.floor(raw.col_off)), int(np.floor(raw.row_off))
        c1, r1 = int(np.ceil(raw.col_off + raw.width)), int(np.ceil(raw.row_off + raw.height))
        if c0 < 0 or r0 < 0 or c1 > src.width or r1 > src.height:
            raise ValueError('MDE não cobre toda a ottobacia.')
        if (r1-r0)*(c1-c0) > 4_000_000:
            raise ValueError('Janela excede 4 milhões de células; use processamento assíncrono ou outra resolução.')
        c0, r0 = max(0, c0-1), max(0, r0-1)
        c1, r1 = min(src.width, c1+1), min(src.height, r1+1)
        window = Window(c0, r0, c1-c0, r1-r0)
        affine = src.window_transform(window)
        flow = src.read(1, window=window, masked=True)
        accumulation = acc.read(1, window=window, masked=True)
        inside = geometry_mask([mapping(basin)], flow.shape, affine, invert=True)
        valid = inside & ~np.ma.getmaskarray(flow) & ~np.ma.getmaskarray(accumulation)
        valid &= np.isfinite(flow.data) & np.isfinite(accumulation.data)
        if np.any(inside & ~valid):
            raise ValueError('NoData ou valores não finitos dentro da ottobacia.')
        if np.any(valid & ~np.isin(flow.data, [0] + [d[0] for d in DIRECTIONS])):
            raise ValueError('Direções incompatíveis: esperado D8 ESRI (0,1,2,4,8,16,32,64,128).')
        # D8 stream extraction is a contributing-area criterion, not a radius.
        min_area = float(request.get('min_drainage_area_km2', 0.1))
        if not np.isfinite(min_area) or min_area <= 0:
            raise ValueError('Área mínima de drenagem deve ser positiva.')
        min_cells = max(1, int(np.ceil(min_area * 1e6 / abs(affine.a * affine.e))))
        candidate_rows, candidate_cols = np.nonzero(valid & (np.abs(accumulation.data) >= min_cells))
        if not len(candidate_rows):
            raise ValueError('Nenhuma célula de drenagem atende à área contribuinte mínima nesta ottobacia.')
        xs = affine.c + (candidate_cols + 0.5) * affine.a
        ys = affine.f + (candidate_rows + 0.5) * affine.e
        distances_sq = (xs - point.x) ** 2 + (ys - point.y) ** 2
        # Nearest first; exact-distance ties prefer proximity to official streams,
        # then accumulation, then stable raster order. No point-distance ceiling.
        ties = np.flatnonzero(np.isclose(distances_sq, distances_sq.min(), rtol=0, atol=1e-6))
        winner = min(ties, key=lambda i: (streams.distance(Point(xs[i], ys[i])),
                     -abs(float(accumulation[candidate_rows[i], candidate_cols[i]])), int(i)))
        row, col = int(candidate_rows[winner]), int(candidate_cols[winner])
        snap_distance = float(np.sqrt(distances_sq[winner]))
        stream_distance = float(streams.distance(Point(xs[winner], ys[winner])))
        selected = upstream_mask(flow.data, valid, (row, col))
        contributing_upstream_codes = []
        raster_valid = ~np.ma.getmaskarray(flow) & ~np.ma.getmaskarray(accumulation)
        for feeder in request.get('inflow_basins', []):
            feeder_geometry = transform(forward, shape(feeder['geometry']))
            feeder_mask = geometry_mask([mapping(feeder_geometry)], flow.shape, affine, invert=True)
            donors_r, donors_c = np.nonzero(feeder_mask & raster_valid & ~inside)
            feeds_selected = False
            for code, dr, dc in DIRECTIONS:
                match = flow.data[donors_r, donors_c] == code
                rr, cc = donors_r[match] + dr, donors_c[match] + dc
                in_grid = (rr >= 0) & (rr < flow.shape[0]) & (cc >= 0) & (cc < flow.shape[1])
                if np.any(selected[rr[in_grid], cc[in_grid]]):
                    feeds_selected = True
                    break
            if feeds_selected:
                contributing_upstream_codes.append(str(feeder['properties']['COBACIA']))
        polygons = [shape(g) for g, value in shapes(selected.astype('uint8'), mask=selected, transform=affine) if value == 1]
        contributing = unary_union(polygons).intersection(basin)
        if contributing.is_empty or not contributing.is_valid:
            raise ValueError('Geometria contribuinte vazia ou inválida.')
        # Remove the authoritative perimeter: return only the internal dividing line.
        remaining = valid & ~selected
        downstream_polygons = [shape(g) for g, value in shapes(remaining.astype('uint8'), mask=remaining, transform=affine) if value == 1]
        divide = (contributing.boundary.intersection(unary_union(downstream_polygons).boundary).intersection(basin)
                  if downstream_polygons else Point().boundary)
        if divide.geom_type == 'GeometryCollection':
            divide = unary_union([part for part in divide.geoms if part.geom_type in ('LineString', 'MultiLineString')])
        if divide.geom_type not in ('LineString', 'MultiLineString'):
            divide = Point().boundary
        snapped = affine * (col+0.5, row+0.5)
        feature = lambda geometry: {'type': 'Feature', 'properties': {}, 'geometry': mapping(transform(backward, geometry))}
        topography, topography_warning = None, None
        if elevation_path and request.get('include_topography', True):
            try:
                topography = render_topography(elevation_path, src, basin)
            except (ValueError, rasterio.errors.RasterioError) as error:
                topography_warning = 'Camada de topografia indisponível: ' + str(error)
        return {'topography': topography, 'topography_warning': topography_warning, 'basin_code': request['basin']['properties'].get('COBACIA'),
                'method': 'dem_d8_esri', 'contributing_area': feature(contributing),
                'divide': None if divide.is_empty else feature(divide),
                'snapped_point': list(backward(*snapped)), 'snap_distance_m': snap_distance,
                'area_km2': contributing.area / 1e6,
                'snapped_accumulation_cells': abs(float(accumulation[row, col])), 'cell_count': int(selected.sum()),
                'resolution_m': [affine.a, -affine.e], 'distance_to_official_stream_m': stream_distance,
                'min_drainage_area_km2': min_area, 'snap_method': 'nearest_d8_drainage_cell',
                'contributing_upstream_codes': contributing_upstream_codes,
                'scope': 'within_ottobasin',
                'warnings': ['Divisor rasterizado; ajuste à drenagem D8 mais próxima requer validação local.'] +
                    (['Acumulação indica possível contribuição externa à cobertura do MDE; área pode estar subestimada.']
                     if np.any(accumulation.data[selected] < 0) else []) +
                    (['Menos de 100 células contribuintes: pode ser cabeceira ou desalinhamento MDE/drenagem; conferir antes de uso operacional.']
                     if selected.sum() < 100 else []) +
                    (['Drenagem topográfica afastada mais de duas células da rede oficial; verificar alinhamento do MDE.']
                     if stream_distance > stream_tolerance else [])}


if __name__ == '__main__':
    try:
        print(json.dumps(delineate(json.load(sys.stdin), *sys.argv[1:4]), allow_nan=False))
    except (ValueError, rasterio.errors.RasterioError) as error:
        print(json.dumps({'error': str(error)}))
