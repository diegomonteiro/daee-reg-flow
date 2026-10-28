"""Disjoint local subcatchments for D8 stream reaches separated at confluences."""
import json
import sys
from collections import defaultdict

import numpy as np
import rasterio
from rasterio.features import geometry_mask, shapes
from rasterio.windows import from_bounds, Window
from pyproj import Transformer
from shapely.errors import GEOSException
from shapely.geometry import shape, mapping
from shapely.ops import transform, unary_union
from delineate import DIRECTIONS
from topography import polygonal_union


def partition(flow, valid, accumulation, min_cells, max_units=5000):
    height, width = flow.shape
    donors = np.flatnonzero(valid)
    codes = flow.ravel()[donors].astype('uint8')
    dr, dc = np.zeros(256, dtype='int8'), np.zeros(256, dtype='int8')
    for code, r, c in DIRECTIONS:
        dr[code], dc[code] = r, c
    rows, cols = donors // width + dr[codes], donors % width + dc[codes]
    receivers = np.full(flow.size, -1, dtype='int64')
    keep = (codes != 0) & (rows >= 0) & (rows < height) & (cols >= 0) & (cols < width)
    source, target = donors[keep], rows[keep]*width + cols[keep]
    keep = valid.ravel()[target]
    receivers[source[keep]] = target[keep]
    # Pointer doubling reaches a terminal in O(log N) vectorized steps for a
    # functional acyclic graph. Any remaining successor belongs to/reaches a cycle,
    # including cycles with tributaries already labelled as channel reaches.
    pointers = receivers.copy()
    for _ in range(int(np.ceil(np.log2(max(2, flow.size)))) + 1):
        active = np.flatnonzero(pointers >= 0)
        if not len(active):
            break
        pointers[active] = pointers[pointers[active]]
    if np.any(pointers[donors] >= 0):
        raise ValueError('Ciclo detectado na rede D8; revise o pré-processamento.')
    channel = valid.ravel() & (np.abs(accumulation.ravel()) >= min_cells)
    if not channel.any():
        raise ValueError('Nenhuma drenagem neste limiar de área; reduza min_drainage_area_km2.')
    channel_ids = np.flatnonzero(channel)
    source = channel_ids[receivers[channel_ids] >= 0]
    source = source[channel[receivers[source]]]
    incoming = np.bincount(receivers[source], minlength=flow.size)
    starts = channel_ids[incoming[channel_ids] != 1]
    labels = np.zeros(flow.size, dtype='int32')
    units = {}
    for start in starts:
        unit = len(units)+1
        if unit > max_units:
            raise ValueError('Mais de 5000 unidades; aumente o limiar de drenagem.')
        current, last = int(start), int(start)
        while current >= 0 and channel[current] and labels[current] == 0:
            labels[current], last = unit, current
            nxt = receivers[current]
            if nxt < 0 or not channel[nxt] or incoming[nxt] != 1:
                break
            current = int(nxt)
        units[unit] = {'kind': 'stream_reach', 'outlet_index': last}
    if np.any(channel & (labels == 0)):
        raise ValueError('Ciclo detectado na rede D8; revise o pré-processamento.')
    # Cells leaving the local mask before reaching a channel are not invented
    # tributary catchments. Keep their terminal drainage areas explicitly residual.
    for terminal in donors[(receivers[donors] < 0) & (labels[donors] == 0)]:
        unit = len(units)+1
        if unit > max_units:
            raise ValueError('Mais de 5000 unidades; revise o limiar ou os limites da ottobacia.')
        labels[terminal] = unit
        units[unit] = {'kind': 'residual_outlet', 'outlet_index': int(terminal)}
    pointers = receivers.copy()
    pending = donors[labels[donors] == 0]
    # Pointer jumping labels all hillslope cells by their first downstream seed.
    for _ in range(int(np.ceil(np.log2(max(2, flow.size))))+2):
        if not len(pending):
            break
        target = pointers[pending]
        if np.any(target < 0):
            raise ValueError('Conexão D8 terminal sem unidade de drenagem.')
        labels[pending] = labels[target]
        pending = pending[labels[pending] == 0]
        pointers[pending] = pointers[pointers[pending]]
    if len(pending):
        raise ValueError('Ciclo detectado em células de encosta do MDE.')
    for unit, props in units.items():
        receiver = receivers[props['outlet_index']]
        downstream = int(labels[receiver]) if receiver >= 0 else 0
        props['downstream_unit_id'] = downstream if downstream and downstream != unit else None
    return labels.reshape(flow.shape), units


def delineate_microbasins(request, flow_path, accumulation_path):
    threshold = float(request.get('min_drainage_area_km2', 0.1))
    if not np.isfinite(threshold) or threshold <= 0:
        raise ValueError('Área mínima de drenagem deve ser positiva.')
    with rasterio.open(flow_path) as src, rasterio.open(accumulation_path) as acc:
        if src.crs != acc.crs or src.transform != acc.transform or src.shape != acc.shape:
            raise ValueError('D8 e acumulação devem usar a mesma grade.')
        if not src.crs or not src.crs.is_projected or src.crs.linear_units != 'metre':
            raise ValueError('Use CRS projetado em metros.')
        if src.transform.b or src.transform.d or src.transform.a <= 0 or src.transform.e >= 0:
            raise ValueError('Use grade norte-acima sem rotação.')
        forward = Transformer.from_crs(4326, src.crs, always_xy=True).transform
        backward = Transformer.from_crs(src.crs, 4326, always_xy=True).transform
        basin = transform(forward, shape(request['basin']['geometry']))
        scope = 'calculated_basin' if request.get('scope') == 'calculated_basin' else 'within_ottobasin'
        if scope == 'calculated_basin':
            # Adjacent official polygons can form an invalid MultiPolygon because
            # they share an edge. Dissolve the final mask before partitioning D8;
            # paths may cross ottobasin boundaries within the selected area.
            basin = polygonal_union(basin)
        if not basin.is_valid or basin.is_empty:
            raise ValueError('Geometria inválida para subdivisão.')
        raw = from_bounds(*basin.bounds, transform=src.transform)
        c0, r0 = int(np.floor(raw.col_off)), int(np.floor(raw.row_off))
        c1, r1 = int(np.ceil(raw.col_off+raw.width)), int(np.ceil(raw.row_off+raw.height))
        if c0 < 0 or r0 < 0 or c1 > src.width or r1 > src.height:
            raise ValueError('MDE não cobre toda a área selecionada.')
        if (r1-r0)*(c1-c0) > 4_000_000:
            raise ValueError('Janela excede 4 milhões de células; requer processamento offline.')
        window = Window(c0,r0,c1-c0,r1-r0)
        affine = src.window_transform(window)
        flow, accumulation = src.read(1,window=window,masked=True),acc.read(1,window=window,masked=True)
        inside = geometry_mask([mapping(basin)],flow.shape,affine,invert=True)
        valid = inside & ~np.ma.getmaskarray(flow) & ~np.ma.getmaskarray(accumulation)
        valid &= np.isfinite(flow.data) & np.isfinite(accumulation.data)
        if np.any(inside & ~valid):
            raise ValueError('NoData ou valores não finitos dentro da área selecionada.')
        if np.any(valid & ~np.isin(flow.data,[0]+[d[0] for d in DIRECTIONS])):
            raise ValueError('Codificação D8 incompatível: esperado ESRI.')
        required_cells = threshold*1e6/abs(affine.a*affine.e)
        if not np.isfinite(required_cells):
            raise ValueError('Limiar de área fora do intervalo numérico suportado.')
        min_cells = max(1,int(np.ceil(required_cells)))
        labels, units = partition(flow.data,valid,accumulation.data,min_cells)
        geometries = defaultdict(list)
        for geometry,label in shapes(labels,mask=valid,transform=affine):
            geometries[int(label)].append(shape(geometry))
        counts = np.bincount(labels[valid],minlength=len(units)+1)
        features, area = [],0.0
        for unit, props in units.items():
            # Boundary contacts can add zero-area lines to an intersection.
            # Keep only polygonal parts so every output remains a valid area.
            polygon = polygonal_union(unary_union(geometries[unit]).intersection(basin))
            if polygon.is_empty or not polygon.is_valid:
                raise ValueError('Unidade vetorizada vazia ou inválida.')
            cell = props['outlet_index']
            outlet = affine*(cell%flow.shape[1]+0.5,cell//flow.shape[1]+0.5)
            unit_area = polygon.area/1e6
            area += unit_area
            features.append({'type':'Feature','properties':{
                'unit_id':unit,'kind':props['kind'],'downstream_unit_id':props['downstream_unit_id'],
                'area_km2':unit_area,'cell_count':int(counts[unit]),'outlet':list(backward(*outlet))},
                'geometry':mapping(transform(backward,polygon))})
        stream_count = sum(p['kind']=='stream_reach' for p in units.values())
        warnings = ['Unidades incrementais locais, sem sobreposição; não são bacias acumuladas nem cadastro oficial.']
        if len(units)>stream_count:
            warnings.append('Áreas que saem da seleção antes de alcançar a rede foram classificadas como residuais.')
        if np.any(accumulation.data[valid]<0):
            warnings.append('Há indicação de contribuição externa à cobertura do MDE.')
        return {'type':'FeatureCollection','features':features,'metadata':{
            'basin_code':str(request['basin']['properties']['COBACIA']) if request['basin']['properties'].get('COBACIA') is not None else None,
            'scope':scope, 'method':'d8_reach_subcatchments',
            'min_drainage_area_km2':threshold,'microbasins_count':stream_count,'residual_count':len(units)-stream_count,
            'valid_cells':int(valid.sum()),'classified_cells':int((labels[valid]>0).sum()),
            'area_km2':area,'basin_area_km2':basin.area/1e6,
            'unclassified_boundary_area_km2':max(0,basin.area/1e6-area),
            'resolution_m':[affine.a,-affine.e],'warnings':warnings}}


if __name__=='__main__':
    try:
        print(json.dumps(delineate_microbasins(json.load(sys.stdin),*sys.argv[1:3]),allow_nan=False))
    except (ValueError,GEOSException,rasterio.errors.RasterioError) as error:
        print(json.dumps({'error':str(error)}))
