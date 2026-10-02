"""Draws docs/screenshot.svg: the mod's terminal footer and card, with made-up numbers.

Every piece of text sits at a character column, so the layout matches the
terminal's monospace grid in any font. Run: python docs/make-screenshot.py
"""
from pathlib import Path
from xml.sax.saxutils import escape

COLS, ROWS = 92, 27
CHAR_W, LINE_H, PAD = 8.4, 20, 16
FONT = "ui-monospace, 'Cascadia Mono', Menlo, Consolas, monospace"

BG = '#1e1e1e'
FG = '#d4d4d4'
DIM = '#8a8a8a'
RULE = '#3a3a3a'
GREEN = '#3fb950'
YELLOW = '#d29922'
RED = '#f85149'
OPUS = '#d97757'
HAIKU = '#629987'

spans = []


def put(row, col, text, color=FG, bold=False):
    # SVG drops spaces at the edges of a piece: move the text right instead.
    stripped = text.strip(' ')
    if stripped:
        lead = len(text) - len(text.lstrip(' '))
        spans.append((row, col + lead, stripped, color, bold))


def right(row, end_col, text, color=FG, bold=False):
    put(row, end_col - len(text), text, color, bold)


COLUMNS = [('Reqs', 6), ('Input', 8), ('Cache read', 12), ('Cache write', 13), ('Output', 9), ('Hit', 8), ('Cost', 10)]
SIDE = 88


def section(row, col, title, span, hit, total, color, forecast, models):
    put(row, col, title, FG, True)
    put(row, col + len(title), f'  {span}', DIM)
    right(row, col + SIDE, total, color, True)
    right(row, col + SIDE - len(total), f'cache hit {hit}   ', DIM)
    put(row + 1, col, forecast, color)
    put(row + 2, col, 'Model', DIM)
    at = col + 14
    for label, width in COLUMNS:
        right(row + 2, at + width, label, DIM)
        at += width
    for offset, (dot, name, values) in enumerate(models):
        line = row + 3 + offset
        put(line, col, '●', dot)
        put(line, col + 2, name)
        at = col + 14
        for index, ((_, width), value) in enumerate(zip(COLUMNS, values)):
            right(line, at + width, value, FG, index == len(COLUMNS) - 1)
            at += width


# The card, in the band above the prompt
put(0, 1, 'API equivalent', FG, True)
put(0, 15, '  cache 42 min left', DIM)
put(0, COLS - 9, '×', DIM)
put(0, COLS - 4, '[-]', DIM)
section(2, 1, '5-hour window', '14:00 – 19:00', '99.6%', '$18.42', GREEN,
        "On pace: won't fill · ~58% at window end · now 31%",
        [(OPUS, 'Opus 5.5', ['148', '310', '61.2M', '402k', '128k', '99.3%', '$18.30']),
         (HAIKU, 'Haiku 4.5', ['9', '74', '412k', '38.6k', '1.9k', '90.6%', '$0.12'])])
section(8, 1, 'Weekly window', 'Thu 11:00 – Thu 11:00', '99.4%', '$163.75', RED,
        'On pace: fills ~Wed 10:30 (in 4d 12h) · now 27%',
        [(OPUS, 'Opus 5.5', ['1342', '2.7k', '512.8M', '3.1M', '1.4M', '99.4%', '$163.21']),
         (HAIKU, 'Haiku 4.5', ['41', '330', '2.1M', '210k', '9.4k', '90.8%', '$0.54'])])
put(14, 1, 'At API list prices · all sessions and subagents included', DIM)

# The prompt and its footer
put(16, 0, '─' * COLS, RULE)
put(17, 0, '>', FG)
put(18, 0, '─' * COLS, RULE)
put(19, 2, '? for shortcuts', DIM)
footer = [('▾ ', DIM), ('cache 42m', '#5ec46a'), (' — ', DIM), ('5h $18.42', GREEN), (' — ', DIM), ('7d $163.75', RED)]
end = COLS - 1
at = end - sum(len(text) for text, _ in footer)
for text, color in footer:
    put(19, at, text, color, color not in (DIM,))
    at += len(text)

# Legend under the terminal
LEGEND_ROW = 22
put(LEGEND_ROW, 0, 'Footer', FG, True)
put(LEGEND_ROW, 8, 'cache countdown, green to red · 5h / 7d: API-equivalent $ of your', DIM)
put(LEGEND_ROW + 1, 8, 'limit windows, red when the limit will not last the window', DIM)
put(LEGEND_ROW + 2, 0, 'Card', FG, True)
put(LEGEND_ROW + 2, 8, 'click ▾ or run /usage-footer · on a wide terminal the windows sit', DIM)
put(LEGEND_ROW + 3, 8, 'side by side · on the Desktop app the footer reads ◷42 — 5h $18', DIM)
put(LEGEND_ROW + 4, 0, 'Sample numbers.', DIM)

width = PAD * 2 + COLS * CHAR_W
height = PAD * 2 + ROWS * LINE_H
TERMINAL_BOTTOM = PAD + 20.4 * LINE_H
out = [
    f'<svg xmlns="http://www.w3.org/2000/svg" width="{width:.0f}" height="{height:.0f}" viewBox="0 0 {width:.0f} {height:.0f}">',
    f'<rect width="100%" height="100%" rx="10" fill="#141414"/>',
    f'<rect x="6" y="6" width="{width - 12:.0f}" height="{TERMINAL_BOTTOM:.0f}" rx="8" fill="{BG}"/>',
    f'<g font-family="{FONT}" font-size="14" xml:space="preserve">',
]
for row, col, text, color, bold in spans:
    x = PAD + col * CHAR_W
    y = PAD + row * LINE_H + 14
    weight = ' font-weight="bold"' if bold else ''
    # textLength pins each piece to its columns whatever the viewer's font is.
    length = f' textLength="{len(text) * CHAR_W:.1f}" lengthAdjust="spacingAndGlyphs"'
    out.append(f'<text x="{x:.1f}" y="{y}" fill="{color}"{weight}{length}>{escape(text)}</text>')
out.append('</g></svg>')

Path(__file__).with_name('screenshot.svg').write_text('\n'.join(out) + '\n', encoding='utf-8')
print('wrote docs/screenshot.svg')
