#!/usr/bin/env python3
"""
Builds docs/ChurchOS_TJM_Movement_Proposal.pdf — two-page proposal for the leadership of
The Jesus Movement (Arete Churches), covering all 32+ Uganda branches.

Regenerate: python3 scripts/build-tjm-movement-proposal.py
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

OUT = "docs/ChurchOS_TJM_Movement_Proposal.pdf"

INK = colors.HexColor("#2B1A0E")
ACCENT = colors.HexColor("#B5622A")
SAND = colors.HexColor("#F0E6D3")
PAPER = colors.HexColor("#FBF7F0")
MUTED = colors.HexColor("#7A5C3E")
LINE = colors.HexColor("#D9CBB4")
RED = colors.HexColor("#C0392B")
REDFILL = colors.HexColor("#FBEDE7")
GREEN = colors.HexColor("#2F6B3C")
GREENFILL = colors.HexColor("#EDF4EE")


def st(name, size, leading=None, font="Helvetica", color=INK, before=0, after=0, align=None):
    return ParagraphStyle(name, fontName=font, fontSize=size, leading=leading or size * 1.4,
                          textColor=color, spaceBefore=before, spaceAfter=after,
                          alignment=align if align is not None else 0)


S = {
    "brand": st("brand", 9, font="Helvetica-Bold", color=ACCENT),
    "title": st("title", 21, 25, "Helvetica-Bold"),
    "sub": st("sub", 10, 14, color=MUTED),
    "h2": st("h2", 12.5, 15, "Helvetica-Bold"),
    "h3": st("h3", 9.5, 12.5, "Helvetica-Bold", color=ACCENT),
    "body": st("body", 9, 12.6),
    "small": st("small", 7.9, 10.6, color=MUTED),
    "cell": st("cell", 8.4, 11.4),
    "cellb": st("cellb", 8.4, 11.4, "Helvetica-Bold"),
    "bignum": st("bignum", 22, 24, "Helvetica-Bold", color=ACCENT, align=TA_CENTER),
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
    canvas.drawString(16 * mm, h - 5.9 * mm, "CHURCHOS  ·  MOVEMENT PROPOSAL  ·  THE JESUS MOVEMENT / ARETE CHURCHES")
    canvas.drawRightString(w - 16 * mm, h - 5.9 * mm, f"November 2026  ·  page {doc.page}")
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.5)
    canvas.line(16 * mm, 13 * mm, w - 16 * mm, 13 * mm)
    canvas.setFillColor(MUTED)
    canvas.setFont("Helvetica", 7)
    canvas.drawString(16 * mm, 8.5 * mm, "churchOs · Kampala, Uganda · 32+ branches, one system")
    canvas.drawRightString(w - 16 * mm, 8.5 * mm, "Live before December")
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


def table(rows, widths, header=True, zebra=True):
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
    ]
    if zebra:
        style.append(("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, PAPER]))
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
                          title="churchOs — 32-branch proposal for The Jesus Movement (Arete Churches)",
                          author="churchOs",
                          subject="Follow-up and records system for all TJM branches in Uganda")
    doc.addPageTemplates([PageTemplate(id="main",
                                       frames=[Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height)],
                                       onPage=decorate)])
    F = []

    # ── page 1 ──────────────────────────────────────────────────────────────
    F += [p("MOVEMENT PROPOSAL", "brand"), Spacer(1, 2 * mm)]
    F += [p("32 branches.<br/>One decision.", "title"), Spacer(1, 2 * mm)]
    F += [p("A follow-up and records system for every TJM congregation in Uganda — live before December.",
            "sub"), Spacer(1, 4 * mm)]

    # the three numbers
    nums = Table([
        [p("32+", "bignum"), p("997", "bignum"), p("7", "bignum")],
        [p("TJM branches in Uganda alone — plus Kenya and online fellowships in four countries", "cell"),
         p("recorded salvations in three days at the Iganga campaign, June 2026", "cell"),
         p("days a week in use: Sunday service, Wednesday Oikos Time, campaign follow-up", "cell")],
    ], colWidths=[60 * mm, 60 * mm, 60 * mm])
    nums.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.8, ACCENT),
        ("INNERGRID", (0, 0), (-1, -1), 0.4, LINE),
        ("BACKGROUND", (0, 0), (-1, 0), SAND),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ALIGN", (0, 0), (-1, 0), "CENTER"),
        ("TOPPADDING", (0, 0), (-1, -1), 2.5 * mm),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5 * mm),
        ("LEFTPADDING", (0, 0), (-1, -1), 2.5 * mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2.5 * mm),
    ]))
    F += [nums, Spacer(1, 4 * mm)]

    F += [table([
        ["To", "From"],
        ["<b>The Jesus Movement — Arete Churches</b><br/>Rev. Dr. Isaac Church Nkuusi — Founder<br/>"
         "The national leadership and the branch pastors of 32+ congregations in Uganda<br/>"
         "Locations across Uganda and Kenya · online fellowships in Rwanda, Algeria, Tanzania and Germany",
         "<b>churchOs</b> — Kampala, Uganda<br/>A Ugandan-built church records system: member register, "
         "new converts, oikos attendance, SMS follow-up, and oversight across branches.<br/>"
         "Contact: [your name] · [phone] · [email]"],
    ], [91 * mm, 91 * mm]), Spacer(1, 4 * mm)]

    F += [p("TJM is no longer a campus fellowship with a handful of meeting points. It is <b>32+ congregations "
            "in Uganda</b>, more in Kenya, and online fellowships on three continents — and every one of them "
            "keeps its people on paper, in different notebooks, in different towns.", "body"), Spacer(1, 2 * mm)]
    F += [p("<b>The founder cannot see his own movement, and the harvest of Iganga is sitting in a box.</b> "
            "This proposal fixes both, in one decision, in two weeks.", "body"), Spacer(1, 4 * mm)]

    F += [head("A", "The three gaps we close", "one system, every branch"), Spacer(1, 3 * mm)]
    F += [table([
        ["", "The gap today", "What the system does"],
        ["<b>1</b>", "<b>Converts are not kept.</b> 997 people repented in Iganga. A campaign card in a box "
         "is not a disciple, and nobody can say how many of the 997 are still walking with God.",
         "Every convert is recorded with a name, phone number, branch and the person who prayed with them — "
         "then three automatic follow-up SMS and assignment to an oikos"],
        ["<b>2</b>", "<b>Oikos attendance is invisible.</b> Wednesday 6pm happens in every oikos, and nobody "
         "above the oikos leader knows who is still meeting and who quietly stopped.",
         "One passkey per oikos, any phone, no login. The branch pastor sees which cells are alive — early "
         "enough to act"],
        ["<b>3</b>", "<b>32 branches, no single view.</b> To know how the movement is doing, somebody has to "
         "call 32 pastors in different districts and add it up by hand.",
         "A national dashboard: every branch, its members, its converts, its attendance, in one screen — for "
         "the founder and the national team"],
    ], [8 * mm, 90 * mm, 84 * mm]), Spacer(1, 4 * mm)]

    F += [box("WHAT WE ASK — ONE DECISION, NOT THIRTY-TWO", [
        "1.  <b>A yes from leadership this week</b> — a rollout decision, not a pilot. Each branch then "
        "activates itself with its own code.",
        "2.  <b>One named coordinator</b> at the national level who owns the rollout. A person, not a "
        "committee.",
        "3.  <b>TJM Makerere as the free reference site</b> — live first, so the other 31 see it working "
        "before they are asked.",
        "4.  <b>Permission to name TJM as a partner</b>, and sixty seconds of video from the founder or a "
        "branch pastor.",
    ])]

    F += [PageBreak()]

    # ── page 2 ──────────────────────────────────────────────────────────────
    F += [head("B", "Two ways to do this", "pick one in the room"), Spacer(1, 3 * mm)]
    F += [table([
        ["", "Per branch", "Movement licence"],
        ["How it works", "Each branch is set up and pays <b>17,000 UGX once</b>, on the day it goes live",
         "One payment covers all 32 branches, one training day, and the national dashboard"],
        ["Cost", "31 branches × 17,000 = <b>527,000</b><br/><i>TJM Makerere is free as the reference site</i>",
         "<b>480,000</b> — a saving of 47,000, paid once"],
        ["Timing", "Paid branch by branch over two to three weeks", "Paid this week; every branch live within "
         "14 days"],
        ["Best if", "Leadership prefers each branch to carry its own cost", "Leadership wants the whole "
         "movement live before December"],
    ], [26 * mm, 78 * mm, 78 * mm]), Spacer(1, 3 * mm)]

    F += [box("IF LEADERSHIP WANTS TO START SMALLER — 5 BRANCHES, 85,000", [
        "Five named branches, live within seven days, at 17,000 each. Makerere first, then four of your "
        "choosing. If it does not work, you stop; if it does, the remaining branches follow at the same price.",
    ], fill=PAPER, border=MUTED), Spacer(1, 4 * mm)]

    F += [head("C", "The fourteen days", "Makerere first, then branches in waves"), Spacer(1, 3 * mm)]
    F += [table([
        ["When", "What happens"],
        ["<b>Days 1–2</b>", "<b>TJM Makerere live.</b> Registers imported, oikos passkeys issued, first SMS "
         "sent. Attendance taken at Oikos Time the same evening"],
        ["<b>Days 3–7</b>", "<b>First wave: 8 branches</b> — Kampala cluster first, then the branches whose "
         "pastors are already asking"],
        ["<b>Days 8–12</b>", "<b>Second wave: 12 branches</b>, set up by phone with a 30-minute call each"],
        ["<b>Days 13–14</b>", "<b>Final wave + national dashboard</b> handed to the founder and coordinator. "
         "One training session recorded for branches that join later"],
    ], [26 * mm, 156 * mm]), Spacer(1, 4 * mm)]

    F += [head("D", "Why this week and not January", ""), Spacer(1, 3 * mm)]
    F += [p("In three weeks your campuses empty. Students travel home for December, and a congregation with no "
            "phone numbers loses them until February. A branch with a list and an SMS pipeline re-gathers them "
            "in the first week of the new term. <b>That is the whole reason this has to be decided now</b> — "
            "not in January, when the people you are trying to keep are already gone.", "body"),
          Spacer(1, 4 * mm)]

    F += [box("WHAT THIS PROPOSAL DOES NOT INCLUDE — PLEASE NOTE", [
        "<b>Online giving and offerings collection are not part of this build.</b> Planned for later this "
        "year, to be proposed separately once the records and follow-up work is proven.",
        "<b>There is no downloadable app.</b> The system runs in the phone's browser, so it works on the "
        "cheapest phone an oikos secretary owns — but we will not call it an app.",
        "<b>Kenya and the online fellowships are not in this price.</b> Uganda's 32 branches first. Kenya "
        "follows on the same terms once the Uganda rollout is stable.",
    ], fill=REDFILL, border=RED), Spacer(1, 4 * mm)]

    F += [p("<b>Next step:</b> twenty minutes with the founder or the national leadership this week. Makerere "
            "can be live the day after that meeting, whichever option you choose.", "small"), Spacer(1, 5 * mm)]

    F += [table([
        ["For churchOs", "For The Jesus Movement"],
        ["Name: _______________________<br/>Signature: ____________________<br/>Date: ___________<br/>"
         "Option chosen: ______________",
         "Name: _______________________<br/>Role: _________________________<br/>Date: ___________<br/>"
         "Branches: ______________"],
    ], [91 * mm, 91 * mm], header=True)]

    doc.build(F)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    build()
