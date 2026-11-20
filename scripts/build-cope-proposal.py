#!/usr/bin/env python3
"""
Builds docs/ChurchOS_COPE_Proposal.pdf — the two/three page partnership proposal to print and
hand to COPE Ministries Uganda (Ministry of Youth / Ministry of Communication) at Ndeeba.

Regenerate: python3 scripts/build-cope-proposal.py
"""

import math

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (
    BaseDocTemplate, Frame, PageTemplate, Paragraph, Spacer, Table, TableStyle,
    PageBreak, KeepTogether,
)

OUT = "docs/ChurchOS_COPE_Proposal.pdf"

INK = colors.HexColor("#2B1A0E")
ACCENT = colors.HexColor("#B5622A")
SAND = colors.HexColor("#F0E6D3")
PAPER = colors.HexColor("#FBF7F0")
MUTED = colors.HexColor("#7A5C3E")
LINE = colors.HexColor("#D9CBB4")
GREEN = colors.HexColor("#2F6B3C")

def st(name, size, leading=None, font="Helvetica", color=INK, before=0, after=0,
       align=TA_LEFT, left=0):
    return ParagraphStyle(name, fontName=font, fontSize=size, leading=leading or size * 1.4,
                          textColor=color, spaceBefore=before, spaceAfter=after,
                          alignment=align, leftIndent=left)

S = {
    "brand":  st("brand", 9, font="Helvetica-Bold", color=ACCENT),
    "title":  st("title", 21, 24, "Helvetica-Bold"),
    "sub":    st("sub", 10, 14, color=MUTED),
    "h2":     st("h2", 12.5, 15, "Helvetica-Bold", before=2, after=3),
    "h3":     st("h3", 9.5, 12.5, "Helvetica-Bold", color=ACCENT),
    "body":   st("body", 9, 12.6),
    "small":  st("small", 7.8, 10.4, color=MUTED),
    "label":  st("label", 6.8, 9, "Helvetica-Bold", color=MUTED),
    "cell":   st("cell", 8.3, 11.2),
    "cellb":  st("cellb", 8.3, 11.2, "Helvetica-Bold"),
    "quote":  st("quote", 9.5, 13.5, font="Helvetica-Oblique", color=INK),
    "num":    st("num", 15, 17, "Helvetica-Bold", color=ACCENT, align=TA_CENTER),
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
    canvas.drawString(16 * mm, h - 5.9 * mm, "CHURCHOS  ·  PARTNERSHIP PROPOSAL  ·  COPE MINISTRIES UGANDA")
    canvas.drawRightString(w - 16 * mm, h - 5.9 * mm, f"November 2026  ·  page {doc.page}")
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.5)
    canvas.line(16 * mm, 13 * mm, w - 16 * mm, 13 * mm)
    canvas.setFillColor(MUTED)
    canvas.setFont("Helvetica", 7)
    canvas.drawString(16 * mm, 8.5 * mm,
                      "churchOs · Kampala, Uganda · prepared for the Ministry of Youth and the Ministry of Communication")
    canvas.drawRightString(w - 16 * mm, 8.5 * mm, "No cost to COPE")
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

def table(rows, widths, header=True, bold_first_col=False):
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
                          title="churchOs — partnership proposal for COPE Ministries Uganda",
                          author="churchOs", subject="Free church records and SMS pilot for COPE member churches")
    doc.addPageTemplates([PageTemplate(id="main",
                                       frames=[Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height)],
                                       onPage=decorate)])
    F = []

    # ── page 1 ───────────────────────────────────────────────────────────────
    F += [p("PARTNERSHIP PROPOSAL", "brand"), Spacer(1, 2 * mm)]
    F += [p("Church records, attendance and SMS<br/>for COPE member churches", "title"), Spacer(1, 2 * mm)]
    F += [p("<b>At no cost to COPE.</b> Prepared for the National Office, and specifically the "
            "<b>Ministry of Youth</b> and the <b>Ministry of Communication</b>.", "sub"), Spacer(1, 4 * mm)]

    F += [table([
        ["Prepared for", "Prepared by"],
        ["<b>COPE Ministries Uganda</b> (Confederation of Pentecostal and Evangelical Ministries)<br/>"
         "Bp. Michael David Kyazze — National General Overseer<br/>Mr. Kizito Joseph — Secretary General<br/>"
         "Mr. Rwegaba Dick — Prime Minister<br/>Plot 348, Ssemakokilo Road, Ndeeba, Kampala<br/>"
         "+256 200 903 450 · info@copeuganda.org",
         "<b>churchOs</b> — Kampala, Uganda<br/>A Ugandan-built church records platform: member registers, "
         "attendance, usher check-in, SMS to members, and multi-branch oversight.<br/>"
         "Contact: [your name] · [phone] · [email]"],
    ], [91 * mm, 91 * mm]), Spacer(1, 5 * mm)]

    F += [p("COPE is a young confederation with roughly 700 member churches and a structure of seven "
            "ministries — including a Ministry of Youth. What follows is a free pilot that gives the "
            "national office real data about its member churches, and gives the Ministry of Youth a "
            "programme it can put its name on.", "body"), Spacer(1, 4 * mm)]

    F += [head("A", "What we propose", "three things, none of which COPE pays for"), Spacer(1, 3 * mm)]
    F += [table([
        ["", "What it is", "What it does for COPE"],
        ["<b>1</b>", "<b>Free platform for member churches.</b> Member records, import from existing paper "
         "registers, attendance, usher check-in with a passkey, SMS to members at 50/= per message, "
         "new-convert and visitor tracking, and reports a pastor can use.",
         "Member churches get something real at no cost, in COPE's name — the fastest way to show members "
         "value they did not have before"],
        ["<b>2</b>", "<b>A COPE national dashboard.</b> One view of member churches — churches, members, "
         "attendance, activity — without asking pastors for reports.",
         "The national office can report on its own membership with figures, not estimates. Already built and "
         "running"],
        ["<b>3</b>", "<b>A COPE Youth Desk programme.</b> A two-hour training per intake for youth leaders "
         "from member churches, a certificate under COPE's name, and a WhatsApp network of trained leaders.",
         "A visible, named youth programme for the Ministry of Youth, delivered by us at our cost"],
    ], [8 * mm, 92 * mm, 82 * mm]), Spacer(1, 4 * mm)]

    F += [box("WHAT WE ASK IN RETURN — FOUR THINGS, NO MONEY", [
        "1.  An <b>endorsement letter</b> on COPE letterhead naming churchOs as a recommended tool for member churches.",
        "2.  A <b>slot at the next COPE gathering</b> — ten minutes, or a table at the door.",
        "3.  <b>Introductions to 20–30 member churches</b> for the pilot, starting with five.",
        "4.  <b>Permission to name COPE as a partner</b> in our materials.",
    ])]

    F += [PageBreak()]

    # ── page 2 ───────────────────────────────────────────────────────────────
    F += [head("B", "How it works in practice", "one Sunday, one pastor, one usher"), Spacer(1, 3 * mm)]
    F += [table([
        ["What happens", "How long it takes"],
        ["The church's existing paper register is imported into the platform — hundreds of members at once, "
         "no retyping", "about 10 minutes"],
        ["Ushers are shown the check-in passkey. One code at the door, any phone, no login", "one service"],
        ["The pastor sends his first SMS to the congregation from the platform wallet at 50/= per message",
         "5 minutes"],
        ["The church appears on the COPE dashboard, with members, attendance and activity", "immediately"],
    ], [140 * mm, 42 * mm]), Spacer(1, 5 * mm)]

    F += [head("C", "What it costs — stated plainly"), Spacer(1, 3 * mm)]
    F += [table([
        ["Item", "Cost"],
        ["Pilot for the first five churches, 30 days", "<b>Free</b>"],
        ["COPE national dashboard", "<b>Free</b>, for as long as the partnership runs"],
        ["Youth leader training and certificates", "<b>Free</b> — churchOs bears the cost"],
        ["A member church continuing after the pilot", "UGX 17,000 once — paid by that church, not by COPE"],
        ["SMS sent by churches", "50/= per message, from the church's own wallet"],
    ], [110 * mm, 72 * mm]), Spacer(1, 3 * mm)]
    F += [p("If COPE later wants its youth programme funded, we propose a documented <b>COPE Youth Fund</b>: a "
            "fixed contribution per activated church, invoiced monthly, in writing, paid to the programme and "
            "never to an individual. We would rather write that down than leave it ambiguous.", "small"),
          Spacer(1, 5 * mm)]

    F += [box("WHAT THIS PROPOSAL DOES NOT INCLUDE — PLEASE NOTE", [
        "<b>Online giving and offerings collection are not part of this build.</b> They are planned for later "
        "this year and will be proposed separately, after the records platform is proven. The pilot covers "
        "member records, attendance, SMS and reporting only.",
        "We say this now so that no pastor is promised something the software cannot yet do.",
    ], fill=colors.HexColor("#FBEDE7"), border=colors.HexColor("#C0392B")), Spacer(1, 5 * mm)]

    F += [head("D", "The 30-day plan", "proposed start: the week you approve"), Spacer(1, 3 * mm)]
    F += [table([
        ["Week", "What happens", "Who does it"],
        ["1", "Five pilot churches onboarded: registers imported, ushers trained, first SMS sent",
         "churchOs + COPE Ministry of Youth"],
        ["2", "First youth-leader training (two hours, 20–30 leaders), certified by COPE",
         "churchOs runs it, COPE hosts"],
        ["3", "COPE national dashboard live for the national office", "churchOs"],
        ["4", "Review: what worked, what to fix, and the decision on wider rollout", "Together"],
    ], [16 * mm, 106 * mm, 60 * mm])]

    F += [PageBreak()]

    # ── page 3 ───────────────────────────────────────────────────────────────
    F += [head("E", "Why us, honestly", ""), Spacer(1, 3 * mm)]
    F += [p("churchOs is built in Kampala by a Ugandan developer, for Ugandan congregations. It is not an "
            "imported product with a foreign price list, and it is not a promise on a brochure — the "
            "software already runs: member registers, CSV import, usher check-in, SMS with delivery reports, "
            "and a multi-branch dashboard.", "body"), Spacer(1, 2 * mm)]
    F += [p("COPE would be among our first networks. We are not going to pretend otherwise, and we would "
            "rather earn the endorsement with five working churches than talk our way into a national "
            "rollout we cannot support. That is exactly why the pilot is free, small and measured in weeks.",
            "body"), Spacer(1, 5 * mm)]

    F += [head("F", "What we need to start", ""), Spacer(1, 3 * mm)]
    F += [table([
        ["#", "Item", "From"],
        ["1", "A 30-minute meeting at Ndeeba with the Ministry of Youth and the Ministry of Communication", "COPE"],
        ["2", "Names of five member churches for the pilot", "COPE"],
        ["3", "An endorsement letter (can follow the pilot, if preferred)", "COPE"],
        ["4", "A date for the first youth-leader training", "Together"],
    ], [8 * mm, 130 * mm, 44 * mm]), Spacer(1, 8 * mm)]

    F += [head("G", "What the platform does today — and what it does not", ""), Spacer(1, 3 * mm)]
    F += [table([
        ["Working today", "Not in this build"],
        ["Member register with import from an existing paper register (CSV)", "Online giving and offerings collection"],
        ["Attendance records and usher check-in with a passkey", "A downloadable mobile app (it runs in a phone browser)"],
        ["SMS to members at 50/= with delivery reports", "Accounting, payroll or school-fees modules"],
        ["New converts, visitors, events and prayer requests", "Automatic transfer of funds to a church bank account"],
        ["Multi-branch dashboard for an overseer or national office", "Integration with a church's existing accounting software"],
        ["Roles: pastor, administrator, usher, overseer", "—"],
    ], [91 * mm, 91 * mm]), Spacer(1, 6 * mm)]

    F += [box("NEXT STEP", [
        "We would like fifteen minutes this week. If the answer is no, we will still run the youth-leader "
        "training for whichever churches COPE sends — the offer does not expire at the end of the meeting.",
    ], fill=PAPER, border=MUTED), Spacer(1, 10 * mm)]

    F += [Spacer(1, 4 * mm)]
    F += [table([
        ["For churchOs", "For COPE Ministries Uganda"],
        ["Name: ______________________________<br/><br/>Signature: ___________________________<br/><br/>"
         "Date: ________________________________<br/><br/>Phone: ______________________________<br/><br/>"
         "Email: ______________________________<br/>",
         "Name: ______________________________<br/><br/>Signature: ___________________________<br/><br/>"
         "Date: ________________________________<br/><br/>Ministry: _____________________________<br/><br/>"
         "Contact: ____________________________"],
    ], [91 * mm, 91 * mm], header=True)]

    doc.build(F)
    print(f"wrote {OUT}")

if __name__ == "__main__":
    build()
