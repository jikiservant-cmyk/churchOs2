#!/usr/bin/env python3
"""
Builds docs/ChurchOS_TJM_Proposal.pdf — two-page follow-up proposal to hand to
The Jesus Movement (Arete Churches) / Rev. Dr. Isaac Church Nkuusi.

Regenerate: python3 scripts/build-tjm-proposal.py
"""

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (
    BaseDocTemplate, Frame, PageTemplate, Paragraph, Spacer, Table, TableStyle,
    PageBreak,
)

OUT = "docs/ChurchOS_TJM_Proposal.pdf"

INK = colors.HexColor("#2B1A0E")
ACCENT = colors.HexColor("#B5622A")
SAND = colors.HexColor("#F0E6D3")
PAPER = colors.HexColor("#FBF7F0")
MUTED = colors.HexColor("#7A5C3E")
LINE = colors.HexColor("#D9CBB4")
RED = colors.HexColor("#C0392B")
REDFILL = colors.HexColor("#FBEDE7")
GREEN = colors.HexColor("#2F6B3C")


def st(name, size, leading=None, font="Helvetica", color=INK, before=0, after=0):
    return ParagraphStyle(name, fontName=font, fontSize=size, leading=leading or size * 1.4,
                          textColor=color, spaceBefore=before, spaceAfter=after)


S = {
    "brand": st("brand", 9, font="Helvetica-Bold", color=ACCENT),
    "title": st("title", 20, 24, "Helvetica-Bold"),
    "sub": st("sub", 10, 14, color=MUTED),
    "h2": st("h2", 12.5, 15, "Helvetica-Bold"),
    "h3": st("h3", 9.5, 12.5, "Helvetica-Bold", color=ACCENT),
    "body": st("body", 9, 12.6),
    "small": st("small", 7.9, 10.6, color=MUTED),
    "cell": st("cell", 8.4, 11.4),
    "cellb": st("cellb", 8.4, 11.4, "Helvetica-Bold"),
    "quote": st("quote", 10, 14, font="Helvetica-Oblique"),
}


def p(t, s="body"):
    return Paragraph(t, S[s])


def decorate(canvas, doc):
    canvas.saveState()
    w, h = A4
    canvas.setFillColor(INK)
    canvas.rect(0, h - 9 * mm, w, 9 * mm, stroke=0, fill=1)
    canvas.setFillColor(SAND)
    canvas.setFont("Helvetica-Bold", 7.2)
    canvas.drawString(16 * mm, h - 5.9 * mm, "CHURCHOS  ·  FOLLOW-UP PROPOSAL  ·  THE JESUS MOVEMENT / ARETE CHURCHES")
    canvas.drawRightString(w - 16 * mm, h - 5.9 * mm, f"November 2026  ·  page {doc.page}")
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.5)
    canvas.line(16 * mm, 13 * mm, w - 16 * mm, 13 * mm)
    canvas.setFillColor(MUTED)
    canvas.setFont("Helvetica", 7)
    canvas.drawString(16 * mm, 8.5 * mm, "churchOs · Kampala, Uganda · free at Makerere · 17,000 per other location")
    canvas.drawRightString(w - 16 * mm, 8.5 * mm, "No cost to the Movement")
    canvas.restoreState()


def head(num, text, note=""):
    t = Table([[p(num, "h3"), p(text, "h2"), p(note, "small")]],
              colWidths=[9 * mm, 118 * mm, 55 * mm])
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "BOTTOM"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        ("LINEBELOW", (0, 0), (-1, -1), 1.2, ACCENT),
    ]))
    return t


def table(rows, widths, header=True):
    data = [[p(c, "cellb" if (header and i == 0) else "cell") for c in row]
            for i, row in enumerate(rows)]
    t = Table(data, colWidths=widths, repeatRows=1 if header else 0)
    style = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("INNERGRID", (0, 0), (-1, -1), 0.4, LINE),
        ("BOX", (0, 0), (-1, -1), 0.7, MUTED),
        ("LEFTPADDING", (0, 0), (-1, -1), 2.5 * mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2.5 * mm),
        ("TOPPADDING", (0, 0), (-1, -1), 2.2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.2),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, PAPER]),
    ]
    if header:
        style.append(("BACKGROUND", (0, 0), (-1, 0), SAND))
    t.setStyle(TableStyle(style))
    return t


def box(title, lines, fill=SAND, border=ACCENT):
    inner = [p(title, "h3")] + [p(l, "cell") for l in lines]
    t = Table([[inner]], colWidths=[182 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), fill),
        ("BOX", (0, 0), (-1, -1), 0.8, border),
        ("LEFTPADDING", (0, 0), (-1, -1), 4 * mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4 * mm),
        ("TOPPADDING", (0, 0), (-1, -1), 3 * mm),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3 * mm),
    ]))
    return t


def build():
    doc = BaseDocTemplate(OUT, pagesize=A4, leftMargin=16 * mm, rightMargin=16 * mm,
                          topMargin=13 * mm, bottomMargin=16 * mm,
                          title="churchOs — follow-up proposal for The Jesus Movement (Arete Churches)",
                          author="churchOs",
                          subject="Free follow-up and oikos records system for TJM locations")
    doc.addPageTemplates([PageTemplate(id="main",
                                       frames=[Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height)],
                                       onPage=decorate)])
    F = []

    # ── page 1 ──────────────────────────────────────────────────────────────
    F += [p("FOLLOW-UP PROPOSAL", "brand"), Spacer(1, 2 * mm)]
    F += [p("997 names from Iganga.<br/>Where are they now?", "title"), Spacer(1, 2 * mm)]
    F += [p("A free follow-up and oikos records system for every TJM location.", "sub"), Spacer(1, 4 * mm)]

    F += [table([
        ["To", "From"],
        ["<b>The Jesus Movement — Arete Churches</b><br/>"
         "Rev. Dr. Isaac Church Nkuusi — Founder<br/>"
         "The location pastors: Mbale Main, Mbale Hospital, Makerere, Mengo, KABZ,<br/>"
         "Nkumba, Kyambogo<br/>Locations across Uganda and Kenya · online fellowships in Rwanda, "
         "Algeria, Tanzania and Germany",
         "<b>churchOs</b> — Kampala, Uganda<br/>A Ugandan-built church records system: member register, "
         "new converts, attendance, usher check-in, SMS, and oversight across locations.<br/>"
         "Contact: [your name] · [phone] · [email]"],
    ], [91 * mm, 91 * mm]), Spacer(1, 5 * mm)]

    F += [p("The Iganga campaign, 24–26 June 2026, Walugogo grounds: <b>997 salvations recorded in three "
            "days</b>. That is a harvest most ministries in this country will never see.", "body"),
          Spacer(1, 2 * mm)]
    F += [p("The question this proposal asks is a simple one. <b>How many of those 997 can be called by name "
            "tonight — and who is responsible for each of them?</b> A campaign card in a box is not a convert "
            "kept. This is the system that keeps them.", "body"), Spacer(1, 5 * mm)]

    F += [head("A", "What we propose", "live this week, not in three months"), Spacer(1, 3 * mm)]
    F += [table([
        ["", "What it is", "What it does for the Movement"],
        ["<b>1</b>", "<b>The convert pipeline.</b> Campaign cards imported in bulk, each new convert recorded "
         "with name, phone, location and who prayed with them — then three automatic follow-up SMS and "
         "assignment to an oikos.",
         "Iganga stops being a number in a report and becomes a list of names somebody is responsible for"],
        ["<b>2</b>", "<b>Oikos attendance.</b> One passkey per oikos, any phone, no login, no app to install. "
         "The oikos secretary keeps the list; the location pastor sees which cells are alive.",
         "The Wednesday 6pm meeting finally has a record — and slipping oikoses are seen early"],
        ["<b>3</b>", "<b>Oversight across locations.</b> The founder and national team see every location in "
         "one view: members, converts, attendance, activity.",
         "Figures from Mbale, Makerere, Mengo, KABZ, Nkumba, Kyambogo and Kenya without asking seven people"],
    ], [8 * mm, 92 * mm, 82 * mm]), Spacer(1, 4 * mm)]

    F += [box("WHAT WE ASK — FOUR THINGS, NO MONEY", [
        "1.  <b>45 minutes at the next Church Growth Conference or Shepherds Camp</b> — a session called "
        "<i>The 997 Names</i>.",
        "2.  <b>Two location pastors for the pilot</b> — TJM Makerere and TJM Mengo, both in Kampala.",
        "3.  <b>One named follow-up lead</b> who owns the pipeline. A person, not a department.",
        "4.  <b>Permission to use the Iganga campaign as the public demo case</b>, with your blessing.",
    ])]

    F += [Spacer(1, 4 * mm)]
    F += [box("THE THREE FOLLOW-UP MESSAGES — FREE, WHETHER WE WORK TOGETHER OR NOT", [
        "<b>Day 1:</b> \u201cPraise God [name]. You gave your life to Jesus at the Iganga campaign, and heaven "
        "is rejoicing over you. Your oikos meets Wednesday at 6pm \u2014 may I send you the details?\u201d",
        "<b>Day 3:</b> \u201c[name], your oikos meets tonight at 6pm with [leader]. You will not walk this road "
        "alone. Can we expect you?\u201d",
        "<b>Day 7:</b> \u201c[name], we missed you. Whatever happened this week, you are still welcome. Reply "
        "YES and I will come to you.\u201d",
        "Then every reply lands in the record, and every convert has a name against them.",
    ], fill=PAPER, border=MUTED)]

    F += [PageBreak()]

    # ── page 2 ──────────────────────────────────────────────────────────────
    F += [head("B", "The session — \u201cThe 997 Names\u201d", "45 minutes, at CGC or Shepherds Camp"),
          Spacer(1, 3 * mm)]
    F += [table([
        ["Min", "Segment", "What happens"],
        ["5", "The question", "\u201c997 repented in Iganga. How many can you call by name tonight?\u201d"],
        ["10", "Every oikos gets a list", "One passkey per oikos, kept by the secretary on any phone"],
        ["10", "Follow-up is three messages", "Day 1 welcome · Day 3 Oikos Time · Day 7 \u201cwe missed you\u201d "
         "— wording given away free"],
        ["10", "Names, not statistics", "Every convert gets an oikos and a person, not a number"],
        ["10", "Live import on stage", "300 names imported from a spreadsheet in front of them. No slides — "
         "the real thing"],
    ], [13 * mm, 50 * mm, 119 * mm]), Spacer(1, 4 * mm)]

    F += [Spacer(1, 4 * mm)]

    F += [head("C", "The week, not the month", "no pilot period — proof in 48 hours"), Spacer(1, 3 * mm)]
    F += [table([
        ["Day", "What happens", "Result"],
        ["<b>Wed AM</b>", "Twenty minutes with the location pastor. Names imported on the spot, oikos "
         "passkeys issued, first SMS sent in the room", "Makerere is live before you leave"],
        ["<b>Wed 6pm</b>", "Oikos Time. Attendance taken with a passkey while you watch", "<b>Your proof — "
         "eight hours, not three Sundays</b>"],
        ["<b>Thu</b>", "Two introductions: Mengo and one more location", "Second and third locations set up "
         "by phone, 17,000 each on the day"],
        ["<b>Fri</b>", "Sixty seconds of video from the location pastor, and permission to name Makerere",
         "A reference that opens the next ten doors"],
        ["<b>Sun</b>", "Makerere's own service — they announce it, you are there", "The case study writes "
         "itself"],
    ], [20 * mm, 100 * mm, 62 * mm]), Spacer(1, 5 * mm)]

    F += [head("D", "What it costs — stated plainly"), Spacer(1, 2 * mm)]
    F += [table([
        ["Item", "Cost"],
        ["<b>TJM Makerere</b> — the reference site, 12 months", "<b>Free</b>"],
        ["Oversight for the founder and national team", "<b>Free</b>"],
        ["The CGC / Shepherds Camp session and the training", "<b>Free</b> — churchOs bears the cost"],
        ["<b>Every other TJM location</b>", "<b>17,000 UGX once</b>, on the day it is set up — paid by that "
         "location, not by the Movement"],
        ["SMS sent by locations", "<b>50/= per message</b>, from that location's own wallet"],
    ], [112 * mm, 70 * mm]), Spacer(1, 3 * mm)]
    F += [p("One free reference location, then every other location pays its own 17,000 on the day it is set "
            "up. No fee is paid to any leader, and none is asked of the Movement.", "small"), Spacer(1, 4 * mm)]

    F += [box("WHAT THIS PROPOSAL DOES NOT INCLUDE — PLEASE NOTE", [
        "<b>Online giving and offerings collection are not part of this build.</b> They are planned for later "
        "this year and will be proposed separately, after the records and follow-up work is proven.",
        "<b>There is no downloadable app.</b> The system runs in the phone's browser, which means it works on "
        "the cheapest phone an oikos secretary owns — but it is not a Play Store app, and we will not call it "
        "one. Bring a cheap phone to the demo and see it there.",
    ], fill=REDFILL, border=RED), Spacer(1, 5 * mm)]

    F += [p("<b>Next step:</b> twenty minutes, this week. If the answer is no, the three follow-up SMS "
            "templates in this sheet are still yours to keep.", "small"), Spacer(1, 4 * mm)]

    F += [table([
        ["For churchOs", "For The Jesus Movement"],
        ["Name: _______________________<br/>Signature: ____________________<br/>Date: ___________",
         "Name: _______________________<br/>Role / Location: ______________<br/>Date: ___________"],
    ], [91 * mm, 91 * mm], header=True)]

    doc.build(F)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    build()
