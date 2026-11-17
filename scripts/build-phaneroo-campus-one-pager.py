#!/usr/bin/env python3
"""
Builds docs/ChurchOS_Manifest_Campus_One_Pager.pdf — ONE page, for the Manifest Fellowship
Central campuses coordinator. Designed to be sent as a WhatsApp PDF and read on a phone.

Regenerate: python3 scripts/build-phaneroo-campus-one-pager.py
"""

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (
    BaseDocTemplate, Frame, PageTemplate, Paragraph, Spacer, Table, TableStyle,
)

OUT = "docs/ChurchOS_Manifest_Campus_One_Pager.pdf"

INK = colors.HexColor("#2B1A0E")
ACCENT = colors.HexColor("#B5622A")
SAND = colors.HexColor("#F0E6D3")
PAPER = colors.HexColor("#FBF7F0")
MUTED = colors.HexColor("#7A5C3E")
LINE = colors.HexColor("#D9CBB4")
RED = colors.HexColor("#C0392B")
REDFILL = colors.HexColor("#FBEDE7")


def st(name, size, leading=None, font="Helvetica", color=INK, before=0, after=0):
    return ParagraphStyle(name, fontName=font, fontSize=size, leading=leading or size * 1.4,
                          textColor=color, spaceBefore=before, spaceAfter=after)


S = {
    "brand": st("brand", 8.5, font="Helvetica-Bold", color=ACCENT),
    "title": st("title", 18, 21, "Helvetica-Bold"),
    "sub": st("sub", 9.5, 13, color=MUTED),
    "h3": st("h3", 9.5, 12.5, "Helvetica-Bold", color=ACCENT),
    "body": st("body", 9, 12.4),
    "cell": st("cell", 8.6, 11.6),
    "cellb": st("cellb", 8.6, 11.6, "Helvetica-Bold"),
    "small": st("small", 7.8, 10.2, color=MUTED),
}


def p(t, s="body"):
    return Paragraph(t, S[s])


def decorate(canvas, doc):
    canvas.saveState()
    w, h = A4
    canvas.setFillColor(INK)
    canvas.rect(0, h - 8 * mm, w, 8 * mm, stroke=0, fill=1)
    canvas.setFillColor(SAND)
    canvas.setFont("Helvetica-Bold", 7)
    canvas.drawString(14 * mm, h - 5.2 * mm, "CHURCHOS  ·  CAMPUS ATTENDANCE REPORTING  ·  MANIFEST FELLOWSHIP")
    canvas.drawRightString(w - 14 * mm, h - 5.2 * mm, "Free · no cost to the ministry")
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.5)
    canvas.line(14 * mm, 11 * mm, w - 14 * mm, 11 * mm)
    canvas.setFillColor(MUTED)
    canvas.setFont("Helvetica", 6.8)
    canvas.drawString(14 * mm, 7 * mm, "churchOs · Kampala, Uganda · [your name] · [phone] · [email]")
    canvas.restoreState()


def table(rows, widths):
    data = [[p(c, "cellb" if i == 0 else "cell") for c in row] for i, row in enumerate(rows)]
    t = Table(data, colWidths=widths)
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BACKGROUND", (0, 0), (-1, 0), SAND),
        ("INNERGRID", (0, 0), (-1, -1), 0.4, LINE),
        ("BOX", (0, 0), (-1, -1), 0.7, MUTED),
        ("LEFTPADDING", (0, 0), (-1, -1), 2.2 * mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2.2 * mm),
        ("TOPPADDING", (0, 0), (-1, -1), 1.8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1.8),
    ]))
    return t


def box(title, lines, fill=PAPER, border=ACCENT):
    inner = [p(title, "h3")] + [p(l, "cell") for l in lines]
    t = Table([[inner]], colWidths=[182 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), fill),
        ("BOX", (0, 0), (-1, -1), 0.8, border),
        ("LEFTPADDING", (0, 0), (-1, -1), 3.5 * mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 3.5 * mm),
        ("TOPPADDING", (0, 0), (-1, -1), 2.5 * mm),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5 * mm),
    ]))
    return t


def build():
    doc = BaseDocTemplate(OUT, pagesize=A4, leftMargin=14 * mm, rightMargin=14 * mm,
                          topMargin=11 * mm, bottomMargin=14 * mm,
                          title="churchOs — campus attendance reporting for Manifest Fellowship",
                          author="churchOs",
                          subject="Free attendance and records system for campus fellowships")
    doc.addPageTemplates([PageTemplate(id="main",
                                       frames=[Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height)],
                                       onPage=decorate)])
    F = []

    F += [p("FOR THE CENTRAL CAMPUSES COORDINATOR", "brand"), Spacer(1, 1.5 * mm)]
    F += [p("One dashboard instead of report forms", "title"), Spacer(1, 1.5 * mm)]
    F += [p("A free attendance and records system for every campus fellowship in the Central region. "
            "No cost to the ministry, and nothing to buy.", "sub"), Spacer(1, 3.5 * mm)]

    F += [p("Right now, the numbers from your campuses arrive as <b>filled report forms and WhatsApp "
            "messages</b> — each leader counting by hand, in a different format, days late. A coordinator "
            "cannot see a campus drifting until somebody stops filling the form altogether.", "body"),
          Spacer(1, 3 * mm)]

    F += [table([
        ["What changes", "How it works"],
        ["<b>Each campus gets its own account</b>",
         "Member list, and attendance taken at the meeting with one passkey — any phone, no login for "
         "members, nothing to install"],
        ["<b>You get one dashboard</b>",
         "Every campus in the Central region in a single view: how many attended, how many are new, which "
         "campuses have gone quiet — before the form would have told you"],
        ["<b>New people are not lost</b>",
         "First-timers recorded with a name and phone number, then three follow-up SMS. A visitor becomes a "
         "member instead of a memory"],
        ["<b>It replaces the form, not the leader</b>",
         "Leaders keep leading. They simply stop counting on paper, and you stop chasing"],
    ], [52 * mm, 130 * mm]), Spacer(1, 3.5 * mm)]

    F += [box("WHAT WE ASK — NO MONEY, THREE THINGS", [
        "1.  <b>Fifteen minutes at the next Central campuses leaders' meeting</b> — to show the leaders "
        "themselves, once.",
        "2.  <b>The names of the campus leaders you already report with</b> — so each one can be set up "
        "personally, free.",
        "3.  <b>Permission to say the system is in use in Manifest fellowships</b> — one sentence, no logo, "
        "no branding change.",
    ]), Spacer(1, 3.5 * mm)]

    F += [box("WHAT THIS DOES NOT DO — SAID PLAINLY", [
        "<b>It does not touch offerings or giving.</b> No money passes through it. That is deliberate.",
        "<b>It is not an app to download.</b> It runs in the phone browser, which is why it works on the "
        "cheapest phone a campus secretary owns.",
        "<b>It does not report doctrine, membership discipline or anything spiritual.</b> Names, attendance "
        "and follow-up only.",
    ], fill=REDFILL, border=RED), Spacer(1, 3.5 * mm)]

    F += [p("<b>Why free:</b> the fellowship tier costs the ministry nothing, and it will stay that way. The "
            "paid product is for congregations with their own budget — a church activating its records at "
            "17,000 once. Campus fellowships are not that customer, and will never be asked to pay.", "small"),
          Spacer(1, 3 * mm)]

    F += [p("<b>To start:</b> reply on WhatsApp and I will set up one campus myself, free, in under ten "
            "minutes — yours to test this week, and yours to stop if you do not like it.", "body")]

    doc.build(F)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    build()
