#!/usr/bin/env python3
"""Build docs/ChurchOS_Friday_Playbook.pdf — the whole plan, in order."""

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import (
    BaseDocTemplate, Frame, PageTemplate, Paragraph, Spacer, Table,
    TableStyle, PageBreak,
)

OUT = "docs/ChurchOS_Friday_Playbook.pdf"

INK = colors.HexColor("#14202B")
ACCENT = colors.HexColor("#B3261E")
TEAL = colors.HexColor("#0F6E63")
GREY = colors.HexColor("#5A6672")
LIGHT = colors.HexColor("#F2F4F6")
RULE = colors.HexColor("#C9D0D6")
WHITE = colors.white
MUTED = colors.HexColor("#D5DBE0")
REDLIGHT = colors.HexColor("#F0B7B3")

PW, PH = A4
LM = RM = 16 * mm
TM = 15 * mm
BM = 15 * mm
CW = PW - LM - RM


def S(name, **kw):
    base = dict(fontName="Helvetica", fontSize=9.4, leading=13, textColor=INK,
                alignment=TA_LEFT, spaceAfter=0)
    base.update(kw)
    return ParagraphStyle(name, **base)


st_kicker = S("kicker", fontName="Helvetica-Bold", fontSize=7.6, textColor=ACCENT,
              leading=10, spaceAfter=2)
st_title = S("title", fontName="Helvetica-Bold", fontSize=27, leading=29, spaceAfter=4)
st_sub = S("sub", fontSize=10.6, leading=14.5, textColor=GREY)
st_h1 = S("h1", fontName="Helvetica-Bold", fontSize=15.5, leading=18, spaceAfter=1)
st_h2 = S("h2", fontName="Helvetica-Bold", fontSize=10.4, leading=13, spaceBefore=7,
          spaceAfter=3)
st_body = S("body", spaceAfter=4)
st_small = S("small", fontSize=8.3, leading=11.2, textColor=GREY)
st_bullet = S("bullet", fontSize=9.4, leading=13, leftIndent=9, bulletIndent=1,
              spaceAfter=2.5)
st_num = S("num", fontSize=9.6, leading=13.4, leftIndent=15, bulletIndent=0,
           spaceAfter=4)
st_white = S("white", fontSize=9.2, leading=12.6, textColor=WHITE)
st_whitelabel = S("wl", fontName="Helvetica-Bold", fontSize=7,
                  textColor=REDLIGHT, leading=9)
st_cell = S("cell", fontSize=8.5, leading=11.2)
st_cellb = S("cellb", fontName="Helvetica-Bold", fontSize=8.5, leading=11.2)
st_head = S("head", fontName="Helvetica-Bold", fontSize=7.8, leading=10, textColor=WHITE)
st_script = S("script", fontName="Helvetica-Oblique", fontSize=9.5, leading=13.6,
              textColor=INK, spaceAfter=3)


def P(txt, style=st_body):
    return Paragraph(txt, style)


def section(num, title, note=None):
    out = [Spacer(1, 3)]
    band = Table([[Paragraph(f"<font size=7.6 color='#B3261E'><b>{num}</b></font>"
                             f"&nbsp;&nbsp;&nbsp;<font size=15.5 color='#14202B'>"
                             f"<b>{title}</b></font>", st_h1)]], colWidths=[CW])
    band.setStyle(TableStyle([
        ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        ("LINEBELOW", (0, 0), (-1, -1), 1.1, INK),
    ]))
    out.append(band)
    if note:
        out.append(Spacer(1, 4))
        out.append(P(note, st_sub))
    out.append(Spacer(1, 6))
    return out


def mk_table(rows, widths, head=True, zebra=True, pad=4.2):
    t = Table(rows, colWidths=widths, repeatRows=1 if head else 0)
    cmds = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), pad),
        ("BOTTOMPADDING", (0, 0), (-1, -1), pad),
        ("LINEBELOW", (0, 0), (-1, -1), 0.4, RULE),
        ("BOX", (0, 0), (-1, -1), 0.6, RULE),
    ]
    if head:
        cmds += [("BACKGROUND", (0, 0), (-1, 0), INK),
                 ("LINEBELOW", (0, 0), (-1, 0), 0.6, INK)]
    if zebra:
        for i in range(1 if head else 0, len(rows)):
            if i % 2 == 0:
                cmds.append(("BACKGROUND", (0, i), (-1, i), LIGHT))
    t.setStyle(TableStyle(cmds))
    return t


def callout(label, body, bg=INK, fg=WHITE, label_color=REDLIGHT, fs=10.2):
    inner = [
        Paragraph(f"<font color='#{label_color.hexval()[2:]}'><b>{label}</b></font>",
                  st_whitelabel),
        Spacer(1, 3),
        Paragraph(body, S("co", fontSize=fs, leading=fs * 1.42, textColor=fg)),
    ]
    t = Table([[inner]], colWidths=[CW])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("LEFTPADDING", (0, 0), (-1, -1), 11), ("RIGHTPADDING", (0, 0), (-1, -1), 11),
        ("TOPPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
    ]))
    return t


def bullets(items, style=st_bullet):
    return [Paragraph(i, style, bulletText="\u2022") for i in items]


def numbered(items, style=st_num):
    return [Paragraph(i, style, bulletText=f"{n}.") for n, i in enumerate(items, 1)]


def on_page(canv, doc):
    canv.saveState()
    canv.setFont("Helvetica", 7.2)
    canv.setFillColor(GREY)
    canv.drawString(LM, 9 * mm, "churchOs \u00b7 founder revenue playbook \u00b7 17 November 2026")
    canv.drawRightString(PW - RM, 9 * mm, f"{doc.page}")
    canv.setStrokeColor(RULE)
    canv.setLineWidth(0.5)
    canv.line(LM, 12.5 * mm, PW - RM, 12.5 * mm)
    canv.restoreState()


def build():
    doc = BaseDocTemplate(OUT, pagesize=A4, leftMargin=LM, rightMargin=RM,
                          topMargin=TM, bottomMargin=BM,
                          title="churchOs - The Friday Playbook",
                          author="churchOs",
                          subject="Founder revenue plan, 17-21 November 2026")
    frame = Frame(LM, BM, CW, PH - TM - BM, id="f", leftPadding=0, rightPadding=0,
                  topPadding=0, bottomPadding=0)
    doc.addPageTemplates([PageTemplate(id="p", frames=[frame], onPage=on_page)])

    F = []

    # ========================================================= 1. COVER
    F.append(Spacer(1, 2))
    F.append(P("churchOS &nbsp;·&nbsp; FOUNDER REVENUE &nbsp;·&nbsp; INTERNAL — NOT FOR CHURCHES",
               st_kicker))
    F.append(P("The Friday Playbook", st_title))
    F.append(P("Everything we have worked out, and the order to do it in.<br/>"
               "Prepared Tuesday 17 November 2026. Money in hand by Friday 20 November.",
               st_sub))
    F.append(Spacer(1, 12))

    money = Table([[
        [Paragraph("THE ONE NUMBER", st_whitelabel),
         Spacer(1, 7),
         Paragraph("<font color='#FFFFFF'><b>1,500,000</b></font>",
                   S("big", fontName="Helvetica-Bold", fontSize=27, leading=29)),
         Spacer(1, 3),
         Paragraph("UGX &nbsp;<font color='#D5DBE0'>in four working days</font>",
                   S("bigsub", fontSize=8.6, leading=11, textColor=WHITE))],
        [Paragraph("HOW IT IS MADE", st_whitelabel),
         Spacer(1, 7),
         Paragraph("<font size=15 color='#FFFFFF'><b>88</b></font>"
                   "<font size=8.6 color='#D5DBE0'> branch activations at 17,000</font>",
                   S("h1", leading=17)),
         Spacer(1, 3),
         Paragraph("<font size=15 color='#FFFFFF'><b>+ 25</b></font>"
                   "<font size=8.6 color='#D5DBE0'> UGX margin on every SMS they send</font>",
                   S("h2", leading=17)),
         Spacer(1, 4),
         Paragraph("No donations. No pilots. Every church activates itself.",
                   S("h3", fontSize=8, leading=10.6, textColor=MUTED))],
    ]], colWidths=[CW * 0.40, CW * 0.60])
    money.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), INK),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (0, 0), 12), ("RIGHTPADDING", (0, 0), (0, 0), 6),
        ("LEFTPADDING", (1, 0), (1, 0), 15), ("RIGHTPADDING", (1, 0), (1, 0), 12),
        ("TOPPADDING", (0, 0), (-1, -1), 11), ("BOTTOMPADDING", (0, 0), (-1, -1), 12),
        ("LINEBEFORE", (1, 0), (1, 0), 0.6, colors.HexColor("#3B4757")),
    ]))
    F.append(money)
    F.append(Spacer(1, 12))

    F += section("01", "If you only do three things",
                 "In this order. Today. Everything else in this document is support for these three.")
    F += numbered([
        "<b>Call +256 776 122 122 — The Worship House.</b> Ask who keeps the Prayer Wave "
        "attendance. Three neighbourhood waves + a main campus = <b>4 sites, 68,000</b>, from one "
        "decision — and it is the exact model you are selling into.",
        "<b>Get TJM's Makerere leader on the phone today.</b> You are inside that building, the "
        "movement has <b>32+ branches</b>, and one warm man can authorise the network. "
        "<b>544,000.</b>",
        "<b>Get the name of the person who receives the Central campus reports at Phaneroo.</b> "
        "Not the Apostle's office, not a centre coordinator — the Central campuses coordinator. "
        "That is the <b>1.1M lane</b>, and it closes next week, not Friday. Find the name this week; "
        "do not spend this week chasing it.",
    ])
    F.append(Spacer(1, 5))

    F += section("02", "Seven rules you do not break",
                 "Each one came out of a real mistake in a real conversation.")
    rules = Table([
        [Paragraph("<b>1</b>", st_cellb), Paragraph("Every church activates itself. You sell the invitation, never the setup. A branch that needs you to load its data is not a customer, it is a job.", st_cell)],
        [Paragraph("<b>2</b>", st_cellb), Paragraph("Never quote a price to students. A campus leader is a proof site, never a customer. The buyer is one level up, always.", st_cell)],
        [Paragraph("<b>3</b>", st_cellb), Paragraph("Never mention the fee pressure. Deadline framing — <i>\"17,000 for a church that activates this week\"</i> — not desperation. Ask for a decision, never for help.", st_cell)],
        [Paragraph("<b>4</b>", st_cellb), Paragraph("Price per branch. Never per member, never a percentage of the offering, never a monthly subscription to start.", st_cell)],
        [Paragraph("<b>5</b>", st_cellb), Paragraph("No pilots, no three-Sunday trials, no \"let me review it and revert\". Same-day proof or nothing.", st_cell)],
        [Paragraph("<b>6</b>", st_cellb), Paragraph("Count the room before you price the room. Walk in, count bodies, then talk. Every number you guess in a call gets audited in person.", st_cell)],
        [Paragraph("<b>7</b>", st_cellb), Paragraph("Prove at the bottom, close at the top. The room that fills on Friday is evidence; the office that signs is the deal.", st_cell)],
    ], colWidths=[7 * mm, CW - 7 * mm])
    rules.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (0, 0), 3), ("RIGHTPADDING", (0, 0), (0, 0), 2),
        ("LEFTPADDING", (1, 0), (1, 0), 4), ("RIGHTPADDING", (1, 0), (1, 0), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 2.8), ("BOTTOMPADDING", (0, 0), (-1, -1), 2.8),
        ("LINEBELOW", (0, 0), (-1, -2), 0.35, RULE),
        ("TEXTCOLOR", (0, 0), (0, -1), ACCENT),
    ]))
    F.append(rules)
    F.append(Spacer(1, 8))

    F += section("03", "In your hand already",
                 "Four documents exist. Send the right paper to the right man, or none at all.")
    F.append(mk_table([
        [Paragraph("DOCUMENT", st_head), Paragraph("GIVE IT TO", st_head),
         Paragraph("WHEN", st_head)],
        [Paragraph("<b>ChurchOS_Manifest_Campus_One_Pager.pdf</b>", st_cell),
         Paragraph("The Central campuses coordinator", st_cell),
         Paragraph("As the first message. Before any meeting.", st_cell)],
        [Paragraph("<b>ChurchOS_TJM_Proposal.pdf</b> / <b>..._Movement_Proposal.pdf</b>", st_cell),
         Paragraph("The branch pastor first, then Nkuusi's office", st_cell),
         Paragraph("Branch, at Wednesday Oikos Time. Movement version only after the leader says yes.", st_cell)],
        [Paragraph("<b>ChurchOS_Bishop_Call_Sheet.pdf</b>", st_cell),
         Paragraph("Your own hand", st_cell),
         Paragraph("While you are on the phone to COPE or a bishop.", st_cell)],
        [Paragraph("<b>ChurchOS_COPE_Proposal.pdf</b>", st_cell),
         Paragraph("COPE secretariat — Kizito Joseph", st_cell),
         Paragraph("Only if they ask for something on paper.", st_cell)],
    ], [CW * 0.40, CW * 0.28, CW * 0.32], pad=3.6))

    F.append(PageBreak())

    # ========================================================= 2. MONEY
    F += section("04", "The money, honestly",
                 "What each thing costs, what it is worth, and what is actually likely this week.")
    F.append(P("<b>Three products, three jobs.</b> They are not a menu — each one exists for a "
               "different reason.", st_body))
    F.append(Spacer(1, 2))
    F.append(mk_table([
        [Paragraph("WHAT", st_head), Paragraph("PRICE", st_head), Paragraph("WHY IT EXISTS", st_head)],
        [Paragraph("Branch activation", st_cellb), Paragraph("<b>17,000</b> once", st_cell), Paragraph("Small enough that a pastor approves it alone, without a committee. The whole business.", st_cell)],
        [Paragraph("SMS margin", st_cellb), Paragraph("<b>25</b> UGX per message", st_cell), Paragraph("Grows with them after the sale. No second conversation, no second price.", st_cell)],
        [Paragraph("Fellowship / campus arm", st_cellb), Paragraph("<b>Free</b> forever", st_cell), Paragraph("It is the proof, not the product. Never quote a price in that room.", st_cell)],
    ], [40 * mm, 30 * mm, CW - 70 * mm]))
    F.append(Spacer(1, 9))

    F.append(P("<b>Where 1.5M actually comes from.</b> Odds are my read of this week, not a promise.",
               st_body))
    F.append(Spacer(1, 2))
    F.append(mk_table([
        [Paragraph("LANE", st_head), Paragraph("SITES", st_head), Paragraph("UGX", st_head), Paragraph("ODDS THIS WEEK", st_head)],
        [Paragraph("Phaneroo manifest centres (10% of 670+)", st_cell), Paragraph("67", st_cellb), Paragraph("1,139,000", st_cellb), Paragraph("Low — the chain is three people deep", st_cell)],
        [Paragraph("TJM branches", st_cell), Paragraph("32", st_cellb), Paragraph("544,000", st_cellb), Paragraph("<b>High</b> — you are warm inside", st_cell)],
        [Paragraph("The Worship House (main + 3 waves)", st_cell), Paragraph("4", st_cellb), Paragraph("68,000", st_cellb), Paragraph("<b>High</b> — published phone, obvious model", st_cell)],
        [Paragraph("Worship fellowship layer", st_cell), Paragraph("8", st_cellb), Paragraph("136,000", st_cellb), Paragraph("Medium — small rooms, fast yes/no", st_cell)],
        [Paragraph("COPE / bishop volume", st_cell), Paragraph("20–60", st_cellb), Paragraph("340k–1.02M", st_cellb), Paragraph("Low — long cycle, do not depend on it", st_cell)],
    ], [CW * 0.38, 16 * mm, 25 * mm, CW * 0.38]))
    F.append(Spacer(1, 9))

    F.append(callout("THE TWO-NETWORK VERSION",
                     "TJM all 32 branches (544,000) + 56 Phaneroo centres (952,000) = "
                     "<b>1,496,000</b>. Four thousand short of the target, and not one SMS sold yet. "
                     "Two phone calls, two men, one week."))
    F.append(Spacer(1, 8))

    F.append(P("<b>And here is what is more likely.</b> Phaneroo's 67 is 10% of 670 centres — a big "
               "number resting on a coordinator you have not met. So plan for the middle: TJM 544,000 "
               "+ Worship House 68,000 + the worship layer 136,000 = <b>748,000</b>, then whatever "
               "Phaneroo gives you by Saturday. That is why the order on the next page puts the calls "
               "you can make today <i>first</i> and the chain you cannot control <i>last</i>.",
               st_body))
    F.append(Spacer(1, 9))

    F.append(P("Why activations, not SMS, close this week", st_h2))
    F.append(mk_table([
        [Paragraph("WHAT IT WOULD TAKE", st_head), Paragraph("THE NUMBER", st_head),
         Paragraph("IS IT A FRIDAY NUMBER?", st_head)],
        [Paragraph("88 branch activations", st_cell), Paragraph("1,496,000", st_cellb),
         Paragraph("<b>Yes.</b> Twenty phone calls and a list of branches.", st_cell)],
        [Paragraph("SMS alone", st_cell), Paragraph("60,000 messages", st_cellb),
         Paragraph("No. That is a ministry's volume, not a church's.", st_cell)],
        [Paragraph("40 activations + the SMS that follows", st_cell),
         Paragraph("680,000 + 820,000", st_cellb),
         Paragraph("Not this week — but this is what December looks like if the branches land.", st_cell)],
    ], [CW * 0.34, CW * 0.24, CW * 0.42]))
    F.append(Spacer(1, 6))
    F.append(P("You cannot send 60,000 SMS in a week. You can make twenty calls. So Friday is an "
               "activation week — the SMS margin is the annuity you buy with it, not the thing you "
               "chase instead.", st_small))

    F.append(PageBreak())

    # ========================================================= 3. ORDER
    F += section("05", "The order — Tuesday 17 to Saturday 21",
                 "Everything with a published number gets called today. Everything that needs a name "
                 "gets asked about today. Nothing waits for a meeting.")

    days = [
        ("TUE 17", "TODAY",
         "<b>Call TJM.</b> Makerere leader first, then ask him who owns the other 31.<br/>"
         "<b>Call The Worship House</b> +256 776 122 122 — ask who keeps the Prayer Wave attendance.<br/>"
         "Send both WhatsApp follow-ups the same evening.",
         "<b>Call The Upper Room Africa</b> +256 777 169855 and <b>TWG</b> +256 753 127 017. Two small "
         "rooms, two fast yes/no answers.",
         "Message your contact inside Manifest and ask for <b>one name</b>: the person who receives the "
         "Central campus reports. Do not pitch through them — just get the name."),
        ("WED 18", "PROOF",
         "Follow up both Tuesday calls. If TJM says \"come\", go — <b>Oikos Time is Wednesday 6 PM</b>.",
         "<b>COPE as backup only:</b> Kizito Joseph, sg@copeuganda.org, +256 200 903 450. Ask for one "
         "branch, not the network.",
         "Send the one-pager to whoever answered, with one line: <i>\"One dashboard instead of report "
         "forms. 15 minutes at your next leaders' meeting.\"</i>"),
        ("THU 19", "THE ROOM",
         "<b>Nansana Prayer Wave, 7–10 PM, The Worship House Main Campus.</b> Go and count. It is the "
         "biggest of the three waves and the one attached to the mother church.",
         "Ask the leader on the door: <i>\"How do you know who came back last week?\"</i> Write the "
         "answer down word for word. It is your pitch for the next three calls.",
         "Confirm Friday night by phone with Kiwatule. Days drift between their website and their TikTok."),
        ("FRI 20", "THE CLOSE",
         "<b>Close on the phone before noon.</b> TJM: how many branches this week. Worship House: four "
         "sites, 68,000 — one invoice or four.",
         "<b>Kiwatule Prayer Wave, 7:30–10:30 PM, Kyambogo Primary School playground</b> (behind Shell). "
         "This is your closing argument, not your opening — arrive with the activations already agreed "
         "and run the roll live in front of them.",
         "Count the money. Text every person who said yes tonight, so Saturday is collection and not "
         "negotiation."),
        ("SAT 21", "COLLECT",
         "Collect the activations. Nothing new — a Saturday pitch reads as a Sunday panic.",
         "Prep the Phaneroo meeting with the name you got on Tuesday. Bring the campus one-pager, not "
         "the sales deck.",
         "Write down what each man actually said. Next week's calls start from those words."),
    ]

    rows = [[Paragraph("DAY", st_head), Paragraph("MORNING — CALLS", st_head),
             Paragraph("AFTERNOON — SECOND FRONT", st_head), Paragraph("EVENING — THE ROOM", st_head)]]
    w = (CW - 19 * mm) / 3
    for d, tag, m, a, e in days:
        rows.append([
            Paragraph(f"<b>{d}</b><br/><font size=7 color='#B3261E'><b>{tag}</b></font>", st_cell),
            Paragraph(m, st_cell), Paragraph(a, st_cell), Paragraph(e, st_cell),
        ])
    F.append(mk_table(rows, [19 * mm, w, w, w], pad=5))
    F.append(Spacer(1, 8))

    F.append(callout("THE RULE FOR THIS WEEK",
                     "If a lane needs a meeting to unlock, it is not a Friday lane. Friday is closed by "
                     "men who answer their phones. Everything else becomes next week's pipeline.",
                     bg=TEAL, label_color=colors.HexColor("#BFE3DC")))
    F.append(Spacer(1, 9))

    F.append(P("The opener — forty seconds, every call, every lane", st_h2))
    F.append(P("\"Morning pastor. My name is [your name], I build churchOs — it is one dashboard that "
               "replaces the report forms. I am not selling anything on this call. I only want to ask "
               "one question: how do you know today who came last week? … If that number is hard to "
               "get, I can show you in ten minutes. When are you in the building?\"", st_script))
    F += bullets([
        "<b>Name your business in the first sentence.</b> A vague opener buys you a polite hang-up.",
        "<b>Ask about their roll, not their church.</b> Everybody has an opinion about their church; "
        "nobody has a number for their roll.",
        "<b>End on a day and a time</b> — never \"let me know\".",
    ])
    F.append(Spacer(1, 5))
    F.append(P("<b>What kills this week:</b> spending Wednesday in a Phaneroo WhatsApp queue, "
               "cold-messaging bishops, building a feature, attending a ticketed concert, or re-pricing "
               "mid-call because a pastor hesitated. Every one of those has already happened once.",
               st_small))

    F.append(PageBreak())

    # ========================================================= 4. TJM + WORSHIP HOUSE
    F += section("06", "Lane 1 — TJM · 544,000 · call today",
                 "Your warmest lane. You are already inside Makerere. Do not treat this like a cold sale.")
    F.append(mk_table([
        [Paragraph("WHO", st_head), Paragraph("DETAIL", st_head)],
        [Paragraph("Movement", st_cellb), Paragraph("TJM — Jesus Movement / <b>Arete Churches</b>, Rev. Dr. <b>Isaac Nkuusi</b>", st_cell)],
        [Paragraph("Scale", st_cellb), Paragraph("<b>32+ branches</b> in Uganda alone. This is the whole reason to start here.", st_cell)],
        [Paragraph("Rhythm", st_cellb), Paragraph("<b>Oikos Time, Wednesday 6 PM</b> — the room where branch people are together.", st_cell)],
        [Paragraph("Your way in", st_cellb), Paragraph("The Makerere leader you already know. Makerere stays <b>free</b> — it is the proof site.", st_cell)],
        [Paragraph("The ask", st_cellb), Paragraph("One activation per branch, <b>17,000</b>, this week. 31 paid × 17,000 = <b>527,000</b>; all 32 = <b>544,000</b>.", st_cell)],
    ], [26 * mm, CW - 26 * mm], pad=3.6))
    F.append(Spacer(1, 6))

    F.append(P("Say it like this", st_h2))
    F.append(P("\"We already run this at Makerere and it is free there — that is the reference. What I "
               "want to know is whether the other branches want it. 17,000 per branch, one time, and "
               "each branch sets itself up with the same code. I am not asking you to run it for them "
               "— I am asking which branches get the code this week.\"", st_script))
    F.append(Spacer(1, 1))
    F += bullets([
        "<b>Ask for the branch list, not a meeting.</b> A list is a decision; a meeting is a delay.",
        "<b>If he says \"start with three\"</b> — accept in the room, then ask for the other 28 names "
        "anyway. Three is a start; the list is the deal.",
    ])
    F.append(Spacer(1, 4))

    F += section("07", "Lane 2 — The Worship House · 68,000 · call today",
                 "Three neighbourhood fellowships, three hired venues, one mother church. The closest "
                 "thing to a machine that already runs your model.")
    F.append(mk_table([
        [Paragraph("WAVE", st_head), Paragraph("WHEN", st_head), Paragraph("WHERE", st_head), Paragraph("CATCHMENT", st_head)],
        [Paragraph("<b>Nansana</b>", st_cell), Paragraph("Thu 7–10 PM", st_cell), Paragraph("Main Campus, Nansana, Hoima Rd", st_cell), Paragraph("Nakulabye, Kasubi, Namungoona, Kawaala, Nabweru, Nansana, Wakiso", st_cell)],
        [Paragraph("<b>Kiwatule</b>", st_cell), Paragraph("Fri 7:30–10:30 PM", st_cell), Paragraph("<b>Kyambogo Primary School playground</b>, behind Shell", st_cell), Paragraph("Kiwatule, Naalya, Kira, Kulambiro, Najjera, Kyambogo, Banda", st_cell)],
        [Paragraph("<b>Busabala</b>", st_cell), Paragraph("Wed 7–10 PM", st_cell), Paragraph("<b>Busabala Primary School</b>", st_cell), Paragraph("Busabala, Muyenga, Kisugu, Ggaba, Bukasa, Nsambya", st_cell)],
    ], [21 * mm, 25 * mm, CW * 0.34, CW - 21 * mm - 25 * mm - CW * 0.34], pad=3.4))
    F.append(Spacer(1, 4))
    F.append(P("<b>Pr. Wilson Bugembe</b>, Nansana along Hoima Road · Tel <b>+256 776 122 122</b> / "
               "+256 392 081 654 · info@theworshiphouseug.org · theworshiphouseug.org · Kiwatule TikTok "
               "@worship.house.kiwatule, ~134K followers", st_small))
    F.append(Spacer(1, 6))

    F.append(P("Say it like this", st_h2))
    F.append(P("\"You run three Prayer Waves and a main campus — four rooms a week, four crowds. Do "
               "those four lists live on one sheet, or are they four WhatsApp groups? Because if it is "
               "four groups, nobody can tell you who came back twice — and that is the only number that "
               "tells you whether a wave is working.\"", st_script))
    F.append(Spacer(1, 2))

    F.append(callout("THE DETAIL THAT SELLS IT",
                     "Two of the three meet in <b>primary school playgrounds</b>. No office, no "
                     "reception, no admin block — so whatever records exist are on somebody's phone. Do "
                     "not say this as an insult. Say it as the reason the tool is small: <i>\"nothing to "
                     "install, nothing to print — the roll runs from your phone.\"</i>", fs=9.4))
    F.append(Spacer(1, 6))

    F += bullets([
        "<b>Price four sites, not one church.</b> 68,000, one decision — the cheapest close of the week.",
        "<b>Confirm the night before.</b> Website says Kiwatule is 7:00 PM; TikTok says 7:30 PM.",
        "<b>Possible fifth site:</b> The Worship Expanse sits in the same orbit (Nansana, Hoima Road, "
        "tagging Pastor Bugembe). Ask at the door: <i>\"Is Expanse under this house, or on its own?\"</i>",
    ])

    F.append(PageBreak())

    # ========================================================= 5. PHANEROO
    F += section("08", "Lane 3 — Phaneroo / Manifest · the 1.1M lane · next week",
                 "The biggest money in the whole plan and the slowest chain. Get the name now; close "
                 "it next week.")
    F.append(P("<b>The chain you have to walk.</b> Every step is a person, and skipping one costs you "
               "the whole lane.", st_body))
    F.append(Spacer(1, 2))
    chain = Table([[
        Paragraph("<font size=7 color='#D5DBE0'>START</font><br/><b>The room</b><br/>"
                  "<font size=7.6 color='#D5DBE0'>students, Tuesday 7 PM, FST Auditorium</font>", st_white),
        Paragraph("<font size=7 color='#D5DBE0'>STEP 1</font><br/><b>Campus leader</b><br/>"
                  "<font size=7.6 color='#D5DBE0'>a student. Unpaid. Not a buyer.</font>", st_white),
        Paragraph("<font size=7 color='#D5DBE0'>STEP 2</font><br/><b>Manifest Central</b><br/>"
                  "<font size=7.6 color='#D5DBE0'>regional coordinator</font>", st_white),
        Paragraph("<font size=7 color='#D5DBE0'>BUYER</font><br/><b>Central campuses coordinator</b><br/>"
                  "<font size=7.6 color='#D5DBE0'>receives the attendance reports</font>", st_white),
        Paragraph("<font size=7 color='#D5DBE0'>SCALE</font><br/><b>670+ centres</b><br/>"
                  "<font size=7.6 color='#D5DBE0'>10% = 67 sites = 1,139,000</font>", st_white),
    ]], colWidths=[CW / 5] * 5)
    chain.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), INK),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 7), ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 9), ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
        ("LINEBEFORE", (1, 0), (-1, -1), 0.5, colors.HexColor("#3B4757")),
    ]))
    F.append(chain)
    F.append(Spacer(1, 7))

    F.append(P("<b>The one question that finds the buyer.</b> Not \"who is in charge of Manifest\" — "
               "everyone will send you to the Apostle's office and you will die there.", st_body))
    F.append(Spacer(1, 2))
    F.append(callout("ASK EXACTLY THIS",
                     "\"Who receives the campus attendance reports for the Central region?\"<br/>"
                     "<font size=8.4 color='#D5DBE0'>It is a reporting question, not a buying question, "
                     "so nobody feels sold to — and the answer is, by definition, the person whose "
                     "problem you solve.</font>", fs=9.8))
    F.append(Spacer(1, 7))

    F.append(P("What you take into that meeting", st_h2))
    F += bullets([
        "<b>The campus one-pager</b> — one page, phone-readable, WhatsApp-sendable. Not the sales deck.",
        "<b>One sentence:</b> \"One dashboard instead of report forms.\"",
        "<b>Three asks, no money:</b> 15 minutes at the next Central leaders' meeting · the names of "
        "the campus leaders · one sentence of endorsement.",
        "<b>Free forever for fellowships.</b> Say it before they ask. It removes the only objection "
        "that matters in a room full of unpaid leaders.",
        "<b>The red box stays in.</b> No offerings, no app download, no reporting on doctrine. That box "
        "is why a ministry will let you near its students.",
    ])
    F.append(Spacer(1, 3))

    F.append(P("Never, in this lane", st_h2))
    F += bullets([
        "Never quote a price to a student, a campus leader, or a fellowship chair.",
        "Never go near the Apostle's office to sell. Protocol gets you a polite blessing and no name.",
        "Never name-drop a contact you have not asked permission to name.",
    ])
    F.append(Spacer(1, 4))

    F.append(P("The ten minutes, in order", st_h2))
    F.append(mk_table([
        [Paragraph("MIN", st_head), Paragraph("WHAT HAPPENS", st_head)],
        [Paragraph("<b>1–2</b>", st_cell), Paragraph("His question first: <i>\"Who receives the campus attendance reports for the Central region?\"</i> Then shut up and listen.", st_cell)],
        [Paragraph("<b>3–5</b>", st_cell), Paragraph("The one page. One dashboard instead of report forms. Show the roll, not the roadmap.", st_cell)],
        [Paragraph("<b>5–7</b>", st_cell), Paragraph("What you are <i>not</i> asking for: no money from students, no logo, no app download, no reporting on doctrine.", st_cell)],
        [Paragraph("<b>7–9</b>", st_cell), Paragraph("The three asks: 15 minutes at the Central leaders' meeting · campus leader names · one sentence of endorsement.", st_cell)],
        [Paragraph("<b>9–10</b>", st_cell), Paragraph("Agree a date and the names of everyone else who must be in the room. Then leave, while it is still going well.", st_cell)],
    ], [14 * mm, CW - 14 * mm], pad=3.2))
    F.append(Spacer(1, 5))
    F.append(P("Office +256 200 999 400 · Gulu chapter +256 785 131 264 (proof they answer province "
               "phones) · Makerere Manifest @ManifestMak, Tuesdays 7 PM, FST Auditorium.", st_small))

    F.append(PageBreak())

    # ========================================================= 6. WORSHIP LAYER + COPE
    F += section("09", "Lane 4 — the worship fellowship layer · 8 rooms · 136,000",
                 "Fellowships of the Expanse type: worship is the main event, the venue is hired, the "
                 "crowd is young, and the whole thing runs on socials.")
    F.append(mk_table([
        [Paragraph("FELLOWSHIP", st_head), Paragraph("WHEN & WHERE", st_head), Paragraph("HOW TO REACH", st_head)],
        [Paragraph("<b>The Worship House</b> — Prayer Wave ×3", st_cellb), Paragraph("Thu 7 PM Nansana · Fri 7:30 PM Kyambogo Primary · Wed 7 PM Busabala Primary", st_cell), Paragraph("<b>+256 776 122 122</b>", st_cell)],
        [Paragraph("<b>The Upper Room Africa</b>", st_cellb), Paragraph("Luzira, 4–7 PM. Worship, Word and the arts", st_cell), Paragraph("<b>+256 777 169855</b><br/><font size=7>theupperroomfoundation@gmail.com</font>", st_cell)],
        [Paragraph("<b>Encounter Worship Fellowship</b>", st_cellb), Paragraph("Monthly gathering, fed by a 10 PM daily online prayer altar", st_cell), Paragraph("realmsofworship.com", st_cell)],
        [Paragraph("<b>ALTAR'D Sound</b>", st_cellb), Paragraph("MCI Media Hub, Tirupati Mazima Mall 4F — recurring Saturday service", st_cell), Paragraph("Millennials for Christ, Apostle Jonah", st_cell)],
        [Paragraph("<b>FNC — \"The Fire Place\"</b>", st_cellb), Paragraph("Friday evenings, Kamwokya, running since March 2012", st_cell), Paragraph("FNC Uganda socials", st_cell)],
        [Paragraph("<b>Trinity Chapel — \"4G\"</b>", st_cellb), Paragraph("Monthly, interdenominational, fills ~150, in a university hub", st_cell), Paragraph("Trinity Chapel Kampala", st_cell)],
        [Paragraph("<b>TWG</b>", st_cellb), Paragraph("ROLEC Makerere, Plot 278 Makerere Hill Rd — all-night worship, trains worship leaders", st_cell), Paragraph("<b>+256 753 127 017</b>", st_cell)],
        [Paragraph("<b>Koinonia</b> / <b>The Remnants</b>", st_cellb), Paragraph("Fridays, Christ's Heart Mukono · Tuesdays, Zoe Grounds Lugogo <i>(verify)</i>", st_cell), Paragraph("Socials only — confirm before travelling", st_cell)],
    ], [CW * 0.28, CW * 0.44, CW * 0.28], pad=3.3))
    F.append(Spacer(1, 5))
    F.append(P("<b>NOTE — not fellowships, do not spend a fare:</b> Worship Bliss (Serena, ticketed), "
               "Praise Exchange (Lugogo, promoter concert), Prophetic Worship Encounter (UMA), Phaneroo "
               "Night of Prayer (Naguru, annual). They are <i>events</i> — a date, a hall, a promoter: no "
               "weekly room, no roll to own. Exception: Worship Bliss runs a worshippers' forum for "
               "worship leaders. Stand in that room for contacts, not for the concert.", st_small))
    F.append(Spacer(1, 5))

    F.append(P("Say it like this", st_h2))
    F.append(P("\"You fill this room every Friday. Who came back the next Friday? Because right now the "
               "answer is nobody knows — and that is the only number that tells you if the fellowship "
               "is growing or just busy.\"", st_script))
    F.append(Spacer(1, 1))
    F.append(P("<b>The three lists every one of them keeps badly:</b> who came · who is in the training "
               "cohort · who is still serving on the team. Pitch against the list they keep worst — "
               "worship schools care about the cohort, prayer waves care about the room.", st_body))
    F.append(Spacer(1, 3))
    F.append(callout("THE MONEY RULE FOR THIS WHOLE LAYER",
                     "A fellowship is almost never the buyer — <b>the mother church is.</b> Expanse → "
                     "Grace Pentecostal Nansana. Koinonia → Christ's Heart Mukono. Prayer Wave → The "
                     "Worship House. Prove in the room, invoice the church behind it.",
                     bg=TEAL, label_color=colors.HexColor("#BFE3DC"), fs=9.4))
    F.append(Spacer(1, 8))

    F += section("10", "Lane 5 — COPE and the bishop calls · backup only",
                 "Real money, wrong clock. Nothing here closes on Friday, so it must never become the "
                 "thing you were counting on.")
    F.append(mk_table([
        [Paragraph("WHO", st_head), Paragraph("REACH", st_head), Paragraph("SCALE", st_head)],
        [Paragraph("COPE — Bp. Michael David Kyazze", st_cell), Paragraph("Kizito Joseph · sg@copeuganda.org · +256 200 903 450", st_cell), Paragraph("~700", st_cell)],
        [Paragraph("Prayer Palace — Bp. Musisi", st_cell), Paragraph("+256 752 483 431", st_cell), Paragraph("258", st_cell)],
        [Paragraph("Gospel Messengers — Bp. Kabona", st_cell), Paragraph("+256 754 425 621", st_cell), Paragraph("120", st_cell)],
        [Paragraph("Deliverance Church — Bp. Idembe", st_cell), Paragraph("+256 773 319 543", st_cell), Paragraph("~270", st_cell)],
    ], [CW * 0.40, CW * 0.40, CW * 0.20], pad=3.4))
    F.append(Spacer(1, 4))
    F.append(P("Ask COPE for <b>one branch</b>, not the network. \"Which one congregation would you let "
               "me prove this in?\" One branch proves you are not selling a story, and bishops respond "
               "to humility far faster than to a proposal.", st_small))

    F.append(PageBreak())

    # ========================================================= 7. OBJECTIONS + KILL
    F += section("11", "The seven things they will say",
                 "Short answers. Do not improvise these — the wrong sentence here costs a network.")
    F.append(mk_table([
        [Paragraph("WHAT THEY SAY", st_head), Paragraph("WHAT YOU SAY BACK", st_head)],
        [Paragraph("\"We already have a system / a book / Excel.\"", st_cellb), Paragraph("\"Then you can tell me in ten seconds who came twice last month. If you can, you do not need me — and I will leave you alone.\"", st_cell)],
        [Paragraph("\"We have no money for this.\"", st_cellb), Paragraph("\"It is 17,000 once, per branch. Not a month. Less than one boda trip a week for a year — and it is not your personal money.\"", st_cell)],
        [Paragraph("\"Let us start with one and see.\"", st_cellb), Paragraph("\"Good. Which one — and can I have the list of the others, so they can decide for themselves? They set themselves up; I do not have to be there.\"", st_cell)],
        [Paragraph("\"Who else is using it?\"", st_cellb), Paragraph("Name the highest-status reference you actually have, and nothing else. Never inflate it; a pastor will check.", st_cell)],
        [Paragraph("\"Can you make it do X first?\"", st_cellb), Paragraph("\"Maybe. But nothing I build this week gets you a roll for Friday. Activate the branch and I will look at X next week.\"", st_cell)],
        [Paragraph("\"Send a proposal, we will revert.\"", st_cellb), Paragraph("\"I will send one page today. But the 17,000 is for a church that activates this week — after that the branches travel home for December and you have no one to count.\"", st_cell)],
        [Paragraph("\"The students can do it themselves, it is free.\"", st_cellb), Paragraph("\"It is free, and it stays free. I am not asking them for money. I am asking you who should get the code first.\"", st_cell)],
    ], [CW * 0.36, CW * 0.64], pad=4.0))
    F.append(Spacer(1, 10))

    F += section("12", "The kill list", "Things that have already cost a day. Do not repeat them.")
    F += bullets([
        "<b>Don't cold-message bishops this week.</b> Long cycle, wrong clock, and it eats the "
        "afternoons you need for follow-ups.",
        "<b>Don't wait on a WhatsApp reply before making the next call.</b> Message, then call someone else.",
        "<b>Don't build anything.</b> Not one feature. The product is not the bottleneck this week.",
        "<b>Don't attend a ticketed concert</b> hoping to meet a pastor. Go to the free rooms.",
        "<b>Don't re-price on hesitation.</b> The moment you discount, 17,000 becomes a suggestion.",
        "<b>Don't tell anyone about the fee pressure.</b> Deadline framing, never desperation — the "
        "moment it reads as \"help me\", the price is capped forever.",
        "<b>Don't argue about doctrine</b> — Phaneroo's or anyone's. You are there about a roll.",
    ])
    F.append(Spacer(1, 10))

    F += section("13", "What I still need from you",
                 "Three things unlock the rest of this document.")
    F += numbered([
        "<b>The Phaneroo coordinator's name.</b> You said you have people inside those fellowships. Ask "
        "for the person who receives the Central campus reports — one name, no pitch through them.",
        "<b>Your name, phone and email.</b> Three PDFs still carry "
        "<i>[your name] · [phone] · [email]</i> placeholders. Give me the real ones and I will rebuild them.",
        "<b>Which calls you can actually make</b> on Tuesday and Wednesday, so I can cut this week down "
        "to what fits your day.",
    ])

    F.append(PageBreak())

    # ========================================================= 8. TRACKER + CLOSE
    F += section("14", "The tracker",
                 "Print this page. Write in it. Do not trust memory on Friday afternoon.")
    tracker = [[Paragraph("WHO", st_head), Paragraph("NUMBER", st_head),
                Paragraph("SITES", st_head), Paragraph("UGX", st_head), Paragraph("STATUS", st_head)]]
    for who, num, sites, ugx in [
        ("TJM — Makerere leader", "your contact", "32", "544,000"),
        ("The Worship House", "+256 776 122 122", "4", "68,000"),
        ("The Upper Room Africa", "+256 777 169855", "1", "17,000"),
        ("TWG", "+256 753 127 017", "1", "17,000"),
        ("Phaneroo Central campuses", "name to get", "67", "1,139,000"),
        ("COPE — Kizito Joseph", "sg@copeuganda.org", "1", "17,000"),
    ]:
        tracker.append([Paragraph(who, st_cell), Paragraph(num, st_cell), Paragraph(sites, st_cell),
                        Paragraph(ugx, st_cellb), Paragraph("", st_cell)])
    blanks = [[Paragraph("&nbsp;", st_cell)] * 5 for _ in range(6)]
    tracker += blanks
    tbl = mk_table(tracker, [CW * 0.33, CW * 0.27, 16 * mm, 24 * mm,
                             CW - CW * 0.60 - 40 * mm], pad=6.0)
    for i in range(len(tracker) - 6, len(tracker)):
        tbl._argH[i] = 9 * mm
    F.append(tbl)
    F.append(Spacer(1, 6))
    F.append(P("TOTAL CONFIRMED _______________________ UGX &nbsp;&nbsp;&nbsp;&nbsp; "
               "STILL SHORT OF 1,500,000 BY _______________________",
               S("tot", fontName="Helvetica-Bold", fontSize=8.6, leading=12, textColor=GREY)))
    F.append(Spacer(1, 10))

    F += section("15", "If Friday fails",
                 "Not a plan to fall back on — a plan to not panic. Decide it now, not at 6 PM Friday.")
    F.append(mk_table([
        [Paragraph("IF", st_head), Paragraph("THEN", st_head)],
        [Paragraph("TJM says yes but only three branches this week", st_cellb),
         Paragraph("Take it, in writing, and ask for the date the other 29 come on. Three activations is 51,000 and a reference with a movement's name on it — that is worth the week.", st_cell)],
        [Paragraph("Worship House says \"after Christmas\"", st_cellb),
         Paragraph("Ask for the Kiwatule wave only, this week, free, as the demonstration. Then invoice in January for all four. A free wave now is a paid network later.", st_cell)],
        [Paragraph("Nobody answers the phone all week", st_cellb),
         Paragraph("Friday night is still the product: go to Kiwatule, count the room, and come home with the one number nobody in that building has. Saturday's calls are ten times easier with a number than with a pitch.", st_cell)],
        [Paragraph("You are short on Friday night", st_cellb),
         Paragraph("Do not discount and do not disappear. Text every single person who talked to you — including the no's — with one line: \"Still building this. One branch, 17,000, whenever you are ready.\" The week after a near-miss is the best week you will have.", st_cell)],
    ], [CW * 0.34, CW * 0.66], pad=4.6))
    F.append(Spacer(1, 10))

    F.append(callout("THE ONLY SENTENCE THAT MATTERS THIS WEEK",
                     "\"Who came back?\"<br/>"
                     "<font size=8.6 color='#D5DBE0'>Every lane, every room, every call. If you ask "
                     "nothing else, ask that — because nobody in this city can answer it, and the man who "
                     "cannot answer it is already looking for you.</font>"))
    F.append(Spacer(1, 8))
    F.append(P("churchOs · 17,000 per branch · 25 UGX per SMS · every church activates itself · "
               "no donations, no pilots. Prepared for the founder, 17 November 2026.",
               S("end", fontSize=7.6, leading=10, textColor=GREY)))

    doc.build(F)


if __name__ == "__main__":
    build()
    import pymupdf
    d = pymupdf.open(OUT)
    print(f"{OUT}: {d.page_count} pages")
