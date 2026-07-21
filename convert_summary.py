#!/usr/bin/env python3
"""Convert summary.md to a formatted PDF."""

from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.lib.colors import HexColor
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    HRFlowable, Preformatted
)
from reportlab.lib.enums import TA_LEFT
import re

def parse_markdown_to_pdf(md_path, pdf_path):
    doc = SimpleDocTemplate(
        pdf_path,
        pagesize=A4,
        leftMargin=25*mm,
        rightMargin=25*mm,
        topMargin=25*mm,
        bottomMargin=25*mm
    )

    styles = getSampleStyleSheet()

    styles.add(ParagraphStyle(
        'DocTitle', parent=styles['Title'],
        fontSize=20, spaceAfter=6*mm, textColor=HexColor('#1a1a2e')
    ))
    styles.add(ParagraphStyle(
        'H2', parent=styles['Heading2'],
        fontSize=16, spaceBefore=8*mm, spaceAfter=4*mm,
        textColor=HexColor('#16213e')
    ))
    styles.add(ParagraphStyle(
        'H3', parent=styles['Heading3'],
        fontSize=13, spaceBefore=5*mm, spaceAfter=3*mm,
        textColor=HexColor('#0f3460')
    ))
    styles.add(ParagraphStyle(
        'BodyText2', parent=styles['Normal'],
        fontSize=10, leading=14, spaceAfter=2*mm
    ))
    styles.add(ParagraphStyle(
        'BulletItem', parent=styles['Normal'],
        fontSize=10, leading=14, leftIndent=10*mm, spaceAfter=1.5*mm,
        bulletIndent=5*mm
    ))
    styles.add(ParagraphStyle(
        'CodeBlock', parent=styles['Code'],
        fontSize=8, leading=11, leftIndent=5*mm,
        backColor=HexColor('#f5f5f5'), spaceAfter=3*mm, spaceBefore=2*mm
    ))
    styles.add(ParagraphStyle(
        'TableHeader', parent=styles['Normal'],
        fontSize=9, leading=12, textColor=HexColor('#ffffff'),
        alignment=TA_LEFT
    ))
    styles.add(ParagraphStyle(
        'TableCell', parent=styles['Normal'],
        fontSize=9, leading=12
    ))

    story = []

    with open(md_path, 'r') as f:
        lines = f.readlines()

    i = 0
    while i < len(lines):
        line = lines[i].rstrip()

        if not line:
            i += 1
            continue

        if line.startswith('# '):
            text = format_inline(line[2:])
            story.append(Paragraph(text, styles['DocTitle']))
            i += 1
            continue

        if line.startswith('## '):
            text = format_inline(line[3:])
            story.append(Spacer(1, 3*mm))
            story.append(HRFlowable(width="100%", thickness=1, color=HexColor('#cccccc')))
            story.append(Paragraph(text, styles['H2']))
            i += 1
            continue

        if line.startswith('### '):
            text = format_inline(line[4:])
            story.append(Paragraph(text, styles['H3']))
            i += 1
            continue

        if line.strip() == '---':
            story.append(Spacer(1, 3*mm))
            story.append(HRFlowable(width="100%", thickness=0.5, color=HexColor('#dddddd')))
            story.append(Spacer(1, 3*mm))
            i += 1
            continue

        if line.startswith('```'):
            i += 1
            code_lines = []
            while i < len(lines) and not lines[i].strip().startswith('```'):
                code_lines.append(lines[i].rstrip())
                i += 1
            i += 1
            code_text = '\n'.join(code_lines)
            story.append(Preformatted(code_text, styles['CodeBlock']))
            continue

        if '|' in line and i + 1 < len(lines) and '---' in lines[i + 1]:
            table_lines = []
            while i < len(lines) and '|' in lines[i]:
                table_lines.append(lines[i].rstrip())
                i += 1
            table = parse_table(table_lines, styles)
            if table:
                story.append(Spacer(1, 2*mm))
                story.append(table)
                story.append(Spacer(1, 2*mm))
            continue

        if line.startswith('- '):
            text = format_inline(line[2:])
            story.append(Paragraph(f"&bull; {text}", styles['BulletItem']))
            i += 1
            continue

        text = format_inline(line)
        story.append(Paragraph(text, styles['BodyText2']))
        i += 1

    doc.build(story)
    print(f"PDF created: {pdf_path}")


def format_inline(text):
    text = text.replace('&', '&amp;')
    text = re.sub(r'\*\*\*(.+?)\*\*\*', r'<b><i>\1</i></b>', text)
    text = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', text)
    text = re.sub(r'\*(.+?)\*', r'<i>\1</i>', text)
    text = re.sub(r'`(.+?)`', r'<font face="Courier" size="9" color="#c0392b">\1</font>', text)
    text = text.replace('<', '&lt;').replace('>', '&gt;')
    text = text.replace('&lt;b&gt;', '<b>').replace('&lt;/b&gt;', '</b>')
    text = text.replace('&lt;i&gt;', '<i>').replace('&lt;/i&gt;', '</i>')
    text = text.replace('&lt;/font&gt;', '</font>')
    text = re.sub(r'&lt;(font[^&]*)&gt;', r'<\1>', text)
    return text


def parse_table(table_lines, styles):
    if len(table_lines) < 3:
        return None

    header_cells = [c.strip() for c in table_lines[0].split('|')[1:-1]]
    data_rows = []
    for line in table_lines[2:]:
        cells = [c.strip() for c in line.split('|')[1:-1]]
        data_rows.append(cells)

    table_data = []
    header_row = [Paragraph(format_inline(c), styles['TableHeader']) for c in header_cells]
    table_data.append(header_row)

    for row in data_rows:
        data_row = [Paragraph(format_inline(c), styles['TableCell']) for c in row]
        table_data.append(data_row)

    num_cols = len(header_cells)
    available_width = A4[0] - 50*mm
    col_width = available_width / num_cols

    table = Table(table_data, colWidths=[col_width] * num_cols)
    table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), HexColor('#2c3e50')),
        ('TEXTCOLOR', (0, 0), (-1, 0), HexColor('#ffffff')),
        ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
        ('FONTSIZE', (0, 0), (-1, -1), 9),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('LEFTPADDING', (0, 0), (-1, -1), 4),
        ('RIGHTPADDING', (0, 0), (-1, -1), 4),
        ('GRID', (0, 0), (-1, -1), 0.5, HexColor('#bdc3c7')),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [HexColor('#ffffff'), HexColor('#f8f9fa')]),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
    ]))
    return table


if __name__ == '__main__':
    parse_markdown_to_pdf(
        '/Users/ayman/Documents/Uniwork/FYP/summary.md',
        '/Users/ayman/Documents/Uniwork/FYP/summary.pdf'
    )
