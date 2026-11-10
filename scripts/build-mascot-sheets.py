#!/usr/bin/env python3
"""Build the Gemini/Qwen mascot strips (packages/assets/src/mascot/<pet>/).

Run by hand after changing scripts/mascot-sources.json; the build never runs it.

    python3 scripts/build-mascot-sheets.py [--proxy URL] [--force] [--only gemini]

The upstream pack is hunmer/aboutme-pets, pinned in mascot-sources.json. Every
source action is a 640x360, 8x15 grid (120 frames at 12 fps) of transparent
WebP. This script selects the action's frames, crops the character's union
alpha box, scales it into a 48x60 logical cell (96x120 CSS: the shared frame
CSS doubles every logical pixel) with the feet on the cell's bottom edge, lays
the cells in one row at 2x display resolution (192x240), and writes a WebP per
state plus sheets.json (frames, box, still, columns). The source WebPs stay in
.debug/mascot-src; only the derived strips and sheets.json are committed.
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import urllib.parse
from pathlib import Path

from PIL import Image, ImageChops, ImageStat

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / 'scripts' / 'mascot-sources.json'
CACHE = ROOT / '.debug' / 'mascot-src'
OUT_ROOT = ROOT / 'packages' / 'assets' / 'src' / 'mascot'
SRC_W, SRC_H = 640, 360
COLS, ROWS = 8, 15
# The shared frame CSS doubles every logical pixel: the table's box is 48x60
# logical (96x120 CSS), and the strip is rendered at 2x display (192x240).
CELL_W, CELL_H = 48, 60
OUT_W, OUT_H = CELL_W * 4, CELL_H * 4
TARGET_H = 208


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def run_curl(url, out, proxy, force):
    if out.exists() and out.stat().st_size > 0 and not force:
        return
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = ['curl', '-sSL', '--fail', '--max-time', '180', '-o', str(out)]
    if proxy:
        cmd += ['-x', proxy]
    cmd.append(url)
    print(f'  fetch {url.rsplit("/", 1)[-1]}')
    result = subprocess.run(cmd)
    if result.returncode != 0:
        out.unlink(missing_ok=True)
        raise SystemExit(f'curl failed ({result.returncode}) for {url}')
    if out.stat().st_size == 0:
        out.unlink(missing_ok=True)
        raise SystemExit(f'empty download for {url}')


def load_catalog(pet, entry, proxy, force):
    cache = CACHE / pet / 'catalog.json'
    url = f'https://raw.githubusercontent.com/{entry["upstream"].split("github.com/")[1]}/{entry["commit"]}/{entry["catalog"]}'
    run_curl(url, cache, proxy, force)
    data = json.loads(cache.read_text(encoding='utf-8'))
    return [item['id'] for item in data.get('animations', [])]


def source_url(entry, pet, action_id):
    quoted = urllib.parse.quote(action_id, safe='')
    return f'https://raw.githubusercontent.com/{entry["upstream"].split("github.com/")[1]}/{entry["commit"]}/pets/{pet}/spritesheet/{quoted}.webp'


def cell(image, index):
    x = (index % COLS) * SRC_W
    y = (index // COLS) * SRC_H
    return image.crop((x, y, x + SRC_W, y + SRC_H)).convert('RGBA')


def union_box(image, start, frames):
    box = None
    for index in range(start, start + frames):
        found = cell(image, index).getchannel('A').getbbox()
        if found is None:
            continue
        if box is None:
            box = list(found)
        else:
            box[0] = min(box[0], found[0])
            box[1] = min(box[1], found[1])
            box[2] = max(box[2], found[2])
            box[3] = max(box[3], found[3])
    if box is None:
        raise SystemExit('an action has no opaque pixels in the selected frames')
    return box


def thumb(image, index, size=(32, 18)):
    return cell(image, index).convert('RGBA').resize(size, Image.LANCZOS)


def diff_score(first, second):
    """Mean per-channel difference of two same-sized RGBA images, 0–255."""
    return sum(ImageStat.Stat(ImageChops.difference(first, second)).mean) / 4


def action_span(image):
    """The frame span where the character actually moves, trimmed of static lead-in and tail."""
    previous = thumb(image, 0)
    motion = []
    for index in range(1, COLS * ROWS):
        current = thumb(image, index)
        motion.append(diff_score(previous, current))
        previous = current
    ordered = sorted(motion)
    baseline = ordered[len(ordered) // 2]
    threshold = max(baseline * 1.5, 0.4)
    active = [index for index, value in enumerate(motion) if value > threshold]
    if not active:
        return 0, COLS * ROWS - 1
    # motion[i] is the step from frame i to i+1: the active frames are i and i+1.
    return active[0], active[-1] + 1


def seam_score(image, start, frames, box):
    first = cell(image, start).crop(box).resize((24, 30), Image.LANCZOS)
    last = cell(image, start + frames - 1).crop(box).resize((24, 30), Image.LANCZOS)
    return diff_score(first, last)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--proxy', default=os.environ.get('HTTPS_PROXY') or 'http://127.0.0.1:7897')
    parser.add_argument('--force', action='store_true', help='download the source again')
    parser.add_argument('--only', choices=['gemini', 'qwen'])
    args = parser.parse_args()

    doc = json.loads(MANIFEST.read_text(encoding='utf-8'))
    entry = {'upstream': doc['upstream'], 'commit': doc['commit']}
    lock = {'upstream': doc['upstream'], 'commit': doc['commit'], 'pets': {}}

    for pet, config in doc['pets'].items():
        if args.only and pet != args.only:
            continue
        print(f'\n== {pet} ==')
        known = set(load_catalog(pet, {**entry, 'catalog': config['catalog']}, args.proxy, args.force))
        source_dir = CACHE / pet
        out_dir = OUT_ROOT / pet
        out_dir.mkdir(parents=True, exist_ok=True)

        images = {}
        action_boxes = {}
        action_spans = {}
        for key, action in config['actions'].items():
            if action['id'] not in known:
                raise SystemExit(f'{pet}: action "{action["id"]}" ({key}) is not in {config["catalog"]}')
            src = source_dir / f'{key}.webp'
            run_curl(source_url(entry, pet, action['id']), src, args.proxy, args.force)
            image = Image.open(src).convert('RGBA')
            if image.size != (SRC_W * COLS, SRC_H * ROWS):
                raise SystemExit(f'{pet}: {key} is {image.size}, expected 5120x5400')
            images[key] = image
            span = action_span(image)
            action_spans[key] = span
            action_boxes[key] = union_box(image, span[0], span[1] - span[0] + 1)
            print(f'  {key}: active frames {span[0]}..{span[1]}')

        idle_box = action_boxes['idle']
        base = min(OUT_W / (idle_box[2] - idle_box[0]), TARGET_H / (idle_box[3] - idle_box[1]))
        print(f'  idle bbox {idle_box}, base scale {base:.3f}')

        derived = {}
        for key, action in config['actions'].items():
            span_start, span_end = action_spans[key]
            # The configured frame count is the most a loop should hold; the
            # active span is the least. Trim the static lead-in and tail, then
            # pick the window whose first and last poses sit closest together.
            frames = max(1, min(action['frames'], span_end - span_start + 1))
            candidates = range(span_start, span_end - frames + 2)
            start = min(candidates, key=lambda at: seam_score(images[key], at, frames, action_boxes[key]))
            box = union_box(images[key], start, frames)
            width, height = box[2] - box[0], box[3] - box[1]
            scale = min(base, OUT_W / width, OUT_H / height)
            strip = Image.new('RGBA', (frames * OUT_W, OUT_H), (0, 0, 0, 0))
            for index in range(frames):
                frame = cell(images[key], start + index).crop(box)
                w = max(1, min(OUT_W, round(width * scale)))
                h = max(1, min(OUT_H, round(height * scale)))
                frame = frame.resize((w, h), Image.LANCZOS)
                strip.alpha_composite(frame, (index * OUT_W + (OUT_W - w) // 2, OUT_H - h))
            path = out_dir / f'{key}.webp'
            strip.save(path, 'WEBP', quality=82, method=6)
            derived[key] = {
                'frames': frames,
                'box': [0, 0, CELL_W, CELL_H],
                'still': min(action['still'], frames - 1),
                'columns': frames,
                'width': frames * OUT_W,
                'height': OUT_H,
                'source': action['id'],
                'start': start,
            }
            print(f'  {key}: {frames} frames from {start}, bbox {width}x{height}, scale {scale:.3f}, {path.stat().st_size // 1024} KB')

        sheets = {}
        for state, action_key in config['states'].items():
            meta = dict(derived[action_key])
            if state == 'landing':
                # The released-drag landing: the idle strip's first three frames,
                # played once before the idle loop takes over.
                meta['frames'] = 3
                meta['still'] = 2
                meta['columns'] = derived[action_key]['columns']
                meta['width'] = derived[action_key]['width']
            sheets[state] = meta
            if state != action_key:
                shutil.copyfile(out_dir / f'{action_key}.webp', out_dir / f'{state}.webp')
        # The build claims one file per state: an action that only feeds aliases
        # (mirror, hum, shy…) must not leave an unclaimed WebP behind.
        for key in config['actions']:
            if key not in config['states']:
                (out_dir / f'{key}.webp').unlink(missing_ok=True)
        (out_dir / 'sheets.json').write_text(json.dumps(sheets, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        lock['pets'][pet] = {
            'sources': {key: sha256(source_dir / f'{key}.webp') for key in config['actions']},
            'states': {key: sha256(out_dir / f'{key}.webp') for key in config['states']},
        }
        print(f'  wrote {out_dir.relative_to(ROOT)}/ ({{}})'.format(', '.join(sorted(sheets))))

    lock_path = ROOT / 'scripts' / 'mascot-sources.lock.json'
    lock_path.write_text(json.dumps(lock, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'\nwrote {lock_path.relative_to(ROOT)}')
    print('\nTS tables (paste into packages/client/src/features/mascot/sheets.ts):')
    for pet in doc['pets']:
        if args.only and pet != args.only:
            continue
        sheets = json.loads((OUT_ROOT / pet / 'sheets.json').read_text(encoding='utf-8'))
        name = pet.upper()
        print(f'\nexport const {name}_FRAME_MS = 83')
        print(f'export const {name}_SHEETS: Record<string, {{ frames: number, box: number[], still: number, columns: number }}> = {{')
        for state, meta in sheets.items():
            print(f"  '{state}': {{ frames: {meta['frames']}, box: [0, 0, {CELL_W}, {CELL_H}], still: {meta['still']}, columns: {meta['columns']} }},")
        print('}')


if __name__ == '__main__':
    main()
