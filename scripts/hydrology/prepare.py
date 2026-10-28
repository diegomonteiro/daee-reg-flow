"""Offline GDAL + GRASS preparation. Run with the project's hydrology Python."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys


def run(*args):
    subprocess.run([str(a) for a in args], check=True)


def grass_job(output):
    import grass.script as gs
    gs.run_command('r.external', input=str(output / 'elevation.tif'), output='elevation')
    gs.run_command('g.region', raster='elevation')
    # Single flow direction, disk-backed processing; A* routes flats/depressions.
    # Preserve negative accumulation to report possible external inflow.
    gs.run_command('r.watershed', flags='sm', elevation='elevation',
                   drainage='direction', accumulation='accumulation', memory=2048)
    # GRASS: NE=1,N=2,NW=3,W=4,SW=5,S=6,SE=7,E=8.
    # Negative directions leave the valid DEM domain; encode as terminal 0.
    gs.mapcalc('d8 = if(direction <= 0, 0, if(direction == 1, 128, '
               'if(direction == 2, 64, if(direction == 3, 32, '
               'if(direction == 4, 16, if(direction == 5, 8, '
               'if(direction == 6, 4, if(direction == 7, 2, 1))))))))')
    options = 'TILED=YES,COMPRESS=LZW,BIGTIFF=IF_SAFER'
    gs.run_command('r.out.gdal', flags='c', input='d8', output=str(output / 'd8.tif'),
                   type='Byte', nodata=255, createopt=options)
    gs.run_command('r.out.gdal', flags='c', input='accumulation', output=str(output / 'accumulation.tif'),
                   type='Float64', nodata=-1.7976931348623157e308, createopt=options)


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--grass-job':
        grass_job(Path(sys.argv[2]))
    else:
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument('dem', type=Path)
        parser.add_argument('output', type=Path)
        parser.add_argument('--bounds', nargs=4, type=float, metavar=('WEST', 'SOUTH', 'EAST', 'NORTH'),
                            help='Optional WGS84 regional extent. Must include hydrologic headwaters; artificial edges are flagged.')
        args = parser.parse_args()
        dem, output = args.dem.resolve(strict=True), args.output.resolve()
        output.mkdir(parents=True, exist_ok=False)
        command = ['gdalwarp', '-t_srs', 'EPSG:5880', '-tr', '30', '30', '-r', 'bilinear',
                   '-dstnodata', '-9999', '-co', 'TILED=YES', '-co', 'COMPRESS=LZW',
                   '-co', 'BIGTIFF=IF_SAFER', '-wm', '512']
        if args.bounds:
            command += ['-te_srs', 'EPSG:4326', '-te', *map(str, args.bounds)]
        run(*command, dem, output / 'elevation.tif')
        # GRASS supplies its Python environment; no reliance on system rasterio.
        run('grass', '-c', output / 'elevation.tif', output / 'grass', '--exec',
            'python3', Path(__file__).resolve(), '--grass-job', output)
        (output / 'manifest.json').write_text(json.dumps({
            'source': str(dem), 'size_bytes': dem.stat().st_size,
            'mtime_ns': dem.stat().st_mtime_ns, 'resolution_m': 30,
            'crs': 'EPSG:5880', 'algorithm': 'GRASS r.watershed -sm',
            'encoding': 'ESRI D8', 'bounds_wgs84': args.bounds,
            'note': 'Elevation units and conditioning against authoritative streams require hydrologist validation.'
        }, indent=2))
