#!/usr/bin/env python3
"""
Builds docs/ChurchOS_Bishop_Call_Sheet.pdf — a printable A4 field document for the
4-day activation sprint: every bishop's name, network size, direct phone numbers,
address, why he will say yes, the opening line, and a call log to fill in by hand.

Regenerate with:  python3 scripts/build-bishop-call-sheet.py

Contact details were collected from the ministries' own websites and public
directories on 2026-11-17. Branch counts are self-reported by the ministries and
vary by source — verify on the call.
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

OUT = "docs/ChurchOS_Bishop_Call_Sheet.pdf"

INK = colors.HexColor("#2B1A0E")
ACCENT = colors.HexColor("#B5622A")
SAND = colors.HexColor("#F0E6D3")
PAPER = colors.HexColor("#FBF7F0")
MUTED = colors.HexColor("#7A5C3E")
LINE = colors.HexColor("#D9CBB4")
GREEN = colors.HexColor("#2F6B3C")

TARGET = 1_500_000
FEE = 17_000
NEEDED = math.ceil(TARGET / FEE)

# ── styles ────────────────────────────────────────────────────────────────────
def st(name, size, leading=None, font="Helvetica", color=INK, space_before=0,
       space_after=0, align=TA_LEFT, left=0):
    return ParagraphStyle(
        name, fontName=font, fontSize=size, leading=leading or size * 1.35,
        textColor=color, spaceBefore=space_before, spaceAfter=space_after,
        alignment=align, leftIndent=left,
    )

S = {
    "brand":   st("brand", 9, font="Helvetica-Bold", color=ACCENT),
    "title":   st("title", 22, 24, "Helvetica-Bold"),
    "sub":     st("sub", 9.5, 13, color=MUTED),
    "h2":      st("h2", 12.5, 15, "Helvetica-Bold", space_before=4, space_after=3),
    "h3":      st("h3", 10, 13, "Helvetica-Bold", color=ACCENT),
    "body":    st("body", 8.8, 12),
    "small":   st("small", 7.6, 10.2, color=MUTED),
    "phone":   st("phone", 11.5, 14, "Helvetica-Bold"),
    "cardname": st("cardname", 12.5, 15, "Helvetica-Bold", color=colors.white),
    "cardmeta": st("cardmeta", 8, 10, color=SAND, align=TA_CENTER),
    "label":   st("label", 6.8, 9, "Helvetica-Bold", color=MUTED),
    "num":     st("num", 14.5, 18, "Helvetica-Bold", color=INK, align=TA_CENTER),
    "cell":    st("cell", 8.2, 11),
    "cellb":   st("cellb", 8.2, 11, "Helvetica-Bold"),
}

def p(text, style="body"):
    return Paragraph(text, S[style])

def money(n):
    return f"UGX {n:,}"

# ── page furniture ───────────────────────────────────────────────────────────
def decorate(canvas, doc):
    canvas.saveState()
    w, h = A4
    canvas.setFillColor(INK)
    canvas.rect(0, h - 9 * mm, w, 9 * mm, stroke=0, fill=1)
    canvas.setFillColor(SAND)
    canvas.setFont("Helvetica-Bold", 7.2)
    canvas.drawString(16 * mm, h - 5.9 * mm, "CHURCHOS  ·  BISHOP CALL SHEET  ·  4-DAY ACTIVATION SPRINT")
    canvas.drawRightString(w - 16 * mm, h - 5.9 * mm,
                           f"TARGET {money(TARGET)}  ·  {NEEDED} ACTIVATIONS  ·  PAGE {doc.page}")
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.5)
    canvas.line(16 * mm, 13 * mm, w - 16 * mm, 13 * mm)
    canvas.setFillColor(MUTED)
    canvas.setFont("Helvetica", 7)
    canvas.drawString(16 * mm, 8.5 * mm,
                      "Every number here is public and was published by the ministry itself. Call between 9:00 and 11:00.")
    canvas.drawRightString(w - 16 * mm, 8.5 * mm, "churchOs · Kampala")
    canvas.restoreState()

# ── building blocks ──────────────────────────────────────────────────────────
def tiles():
    """Four headline numbers across the top."""
    data = [
        [p("TARGET", "label"), p("PER ACTIVATION", "label"),
         p("ACTIVATIONS NEEDED", "label"), p("SMS MARGIN", "label")],
        [p(money(TARGET), "num"), p(money(FEE), "num"),
         p(str(NEEDED), "num"), p("25 / SMS", "num")],
    ]
    t = Table(data, colWidths=[44 * mm] * 4, rowHeights=[7 * mm, 12 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), SAND),
        ("BOX", (0, 0), (-1, -1), 0.6, LINE),
        ("INNERGRID", (0, 0), (-1, -1), 0.4, colors.white),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
    ]))
    return t

def section_head(number, text, note=""):
    head = Table([[p(f"{number}", "h3"), p(text, "h2"), p(note, "small")]],
                 colWidths=[9 * mm, 122 * mm, 51 * mm])
    head.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "BOTTOM"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        ("LINEBELOW", (0, 0), (-1, -1), 1.2, ACCENT),
    ]))
    return head

def bishop_card(rank, name, branches, potential, leader, phones, email, address,
                web, why, opening, note=None):
    """A full card: coloured name bar, contacts on the left, pitch + call log on the right."""
    bar = Table(
        [[p(f"{rank}.  {name}", "cardname"),
          p(f"{branches} branches  ·  {money(potential)} potential", "cardmeta")]],
        colWidths=[122 * mm, 60 * mm],
    )
    bar.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), INK),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (0, 0), 4 * mm),
        ("RIGHTPADDING", (1, 0), (1, 0), 4 * mm),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))

    left = [p("LEADER", "label"), p(leader, "cellb"), Spacer(1, 2.5 * mm),
            p("PHONE", "label")]
    left += [p(ph, "phone") for ph in phones]
    left += [Spacer(1, 1.5 * mm), p("EMAIL", "label"), p(email, "cell"),
             Spacer(1, 1.5 * mm), p("ADDRESS", "label"), p(address, "cell")]
    if web:
        left += [Spacer(1, 1.5 * mm), p(web, "small")]

    right = [p("WHY HE SAYS YES", "label"), p(why, "cell"),
             Spacer(1, 2.5 * mm), p("OPENING LINE", "label"), p(opening, "cell")]
    if note:
        right += [Spacer(1, 2 * mm), p(note, "small")]
    right += [Spacer(1, 2.5 * mm), p("CALL LOG", "label"),
              p("date _______  time _______  spoke to ____________________", "small"),
              p("[  ] meeting booked   [  ] send invite code   [  ] not now   [  ] refused", "small"),
              p("next step ________________________  agreed ______________", "small")]

    body = Table([[left, right]], colWidths=[74 * mm, 108 * mm])
    body.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BACKGROUND", (0, 0), (-1, -1), PAPER),
        ("BOX", (0, 0), (-1, -1), 0.6, LINE),
        ("LINEAFTER", (0, 0), (0, 0), 0.5, LINE),
        ("LEFTPADDING", (0, 0), (-1, -1), 4 * mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4 * mm),
        ("TOPPADDING", (0, 0), (-1, -1), 3 * mm),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3 * mm),
    ]))
    return KeepTogether([bar, body, Spacer(1, 4.5 * mm)])

def mini_table(rows, widths, header=True, font_size=8.2):
    data = []
    for i, row in enumerate(rows):
        data.append([p(c, "cellb" if (header and i == 0) else "cell") for c in row])
    t = Table(data, colWidths=widths, repeatRows=1 if header else 0)
    style = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("INNERGRID", (0, 0), (-1, -1), 0.4, LINE),
        ("BOX", (0, 0), (-1, -1), 0.7, MUTED),
        ("LEFTPADDING", (0, 0), (-1, -1), 2.5 * mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2.5 * mm),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, PAPER]),
    ]
    if header:
        style += [("BACKGROUND", (0, 0), (-1, 0), SAND)]
    t.setStyle(TableStyle(style))
    return t

def callout(title, lines, fill=SAND, border=ACCENT):
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

# ── document ─────────────────────────────────────────────────────────────────
def build():
    doc = BaseDocTemplate(
        OUT, pagesize=A4,
        leftMargin=16 * mm, rightMargin=16 * mm,
        topMargin=13 * mm, bottomMargin=16 * mm,
        title="churchOs — Bishop Call Sheet", author="churchOs",
        subject="4-day activation sprint call sheet",
    )
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="body")
    doc.addPageTemplates([PageTemplate(id="main", frames=[frame], onPage=decorate)])

    F = []  # flowables

    # ── page 1: cover / instructions ─────────────────────────────────────────
    F += [p("FIELD DOCUMENT  ·  PRINT AND CARRY", "brand"), Spacer(1, 2 * mm)]
    F += [p("The Bishop Call Sheet", "title")]
    F += [p("Every pastor below decides for a whole network of churches — not one congregation. "
            "Eight calls, at most four meetings, and the week is won or lost.", "sub")]
    F += [Spacer(1, 4 * mm), tiles(), Spacer(1, 5 * mm)]

    F += [section_head("A", "How to use this sheet"), Spacer(1, 2.5 * mm)]
    F += [mini_table([
        ["Step", "What you do", "Time"],
        ["1", "Call the first number on each card. It is the leader's own mobile, not a switchboard.", "9:00–11:00"],
        ["2", "Use the opening line word for word. It names his branch count — that is why he keeps listening.", "60 sec"],
        ["3", "Ask for one thing only: <b>15 minutes, and you will come to him</b>. Never ask for money on the phone.", "1 min"],
        ["4", "Book the meeting, then WhatsApp the same day to confirm. A booking not confirmed is lost.", "same day"],
        ["5", "Fill the call log on the card as you speak. Memory of eight calls is worthless by 4pm.", "live"],
    ], [12 * mm, 140 * mm, 30 * mm]), Spacer(1, 4 * mm)]

    F += [callout("THE ONE RULE FOR THIS WEEK", [
        "Mention the <b>deadline</b>, never the <b>shortfall</b>. Say: \"I'm launching my first 20 churches this week, "
        "so I'm giving founding pricing.\" Never say: \"I need fees by Friday.\" "
        "The first makes you a founder with a closing date. The second makes you a charity case with 20,000 in his pocket.",
    ]), Spacer(1, 4 * mm)]

    F += [callout("WHAT YOU MUST NOT SELL", [
        "Do <b>not</b> offer online giving or \"MoMo collections\" — that feature is switched off in this build. "
        "Sell members, attendance, usher check-in, SMS broadcasts at 50 UGX, and the diocese dashboard. "
        "If he asks about giving, say \"coming later this year\" and move to the dashboard. "
        "One bishop who pays expecting collections and finds \"coming soon\" will poison his whole network against you.",
    ], fill=colors.HexColor("#FBEDE7"), border=colors.HexColor("#C0392B")), Spacer(1, 4 * mm)]

    F += [section_head("B", "The price sheet you quote"), Spacer(1, 2.5 * mm)]
    F += [mini_table([
        ["Bundle", "Price", "You give free", "Your cost"],
        ["1 branch", money(FEE), "—", "—"],
        ["20 branches", money(FEE * 20), "20 free SMS each", "10,000"],
        ["30 branches", money(FEE * 30), "1,000 free SMS + diocese dashboard", "25,000"],
        ["50+ branches", money(FEE * 50), "White-label logo + colours", "0 (already built)"],
        ["Setup / training add-on", "50,000–100,000 per church", "Members entered + ushers trained", "your afternoon"],
    ], [40 * mm, 42 * mm, 65 * mm, 35 * mm]), Spacer(1, 2 * mm)]
    F += [p("Never discount the single 17,000. Discount only in volume, and discount with SMS credit — "
            "it costs you 25 and is worth 50 to him. The setup fee is the honest way to make the numbers work: "
            f"at 67,000 per church you need {NEEDED * 17 // 67} churches, not {NEEDED}.", "small")]
    F += [Spacer(1, 4 * mm)]

    F += [section_head("C", "The 3-minute pitch, word for word"), Spacer(1, 2.5 * mm)]
    F += [callout("SAY THIS IN THE MEETING", [
        "\"Bishop, right now when you want to reach all your branches you call thirty pastors one by one, and when "
        "you want the attendance of the whole ministry you wait for a paper report.",
        "This system gives you one dashboard for every branch — members, attendance, converts — and lets you SMS "
        "all your members from one wallet at fifty shillings a message, cheaper than what you pay today.",
        "My normal price is 17,000 per branch, once. Because you are bringing thirty, I will do the whole ministry "
        "and throw in 1,000 free SMS so you can announce to everyone this Sunday. Your pastors register with one "
        "code I give you, and each one activates from his own phone — you do not chase anybody.\"",
    ], fill=PAPER, border=MUTED)]

    F += [PageBreak()]

    # ── page 2-4: the A-list ────────────────────────────────────────────────
    F += [section_head("D", "A-LIST — call these eight first", "the decision-maker answers his own phone"),
          Spacer(1, 3 * mm)]

    F += [bishop_card(
        1, "PRAYER PALACE CHRISTIAN CENTRE", 258, 258 * FEE,
        "Bishop Grivas K. Musisi — Overseer / Founder",
        ["+256 752 483 431  (Bishop, mobile)", "+256 784 172 045  (Bishop, mobile)",
         "+256 414 266 362  (office)"],
        "pradunkyssa@gmail.com",
        "Plot 1326, Mobutu Road, Kibuye–Juuko Zone, opposite Katwe Police Station, Makindye, Kampala.",
        "prayerpalaceug.org",
        "One bishop, 258 branches, and he decides alone — no board, no committee. He also runs Dunamis Radio, "
        "so he already understands reaching thousands at once. Highest value per meeting on this sheet.",
        "\"Bishop, you have 258 branches. Today, getting attendance from all of them means waiting for paper. "
        "I can show you one screen with every branch on it — fifteen minutes, and I'll come to Kibuye.\"",
        "Counts differ by source: one publication says 375 planted. Ask him for the real number and write it down.")]

    F += [bishop_card(
        2, "GOSPEL MESSENGERS CHURCH", 120, 120 * FEE,
        "Rev. Moses Ssemanda Mbuga (\"Kabona\") — Head of the Church",
        ["+256 754 425 621  (Kabona, direct)", "+256 772 620 657",
         "+256 752 626 109", "+256 779 914 067  (WhatsApp)"],
        "gospelmessengerschurchug@gmail.com",
        "Lusaka Zone VI, Makindye I Parish, Makindye, Kampala. P.O. Box 3940.",
        "gospelmessengers.church",
        "Family-run since 1978 — his father founded it. One man's yes is the whole network, and there is no board "
        "to convince. They run the SOMA Bible school on site, so dozens of pastors are in one building.",
        "\"Kabona, you have 120 branches and a Bible school. I built one dashboard for the whole ministry, and SMS to "
        "every branch from a single wallet at 50 shillings. May I show you on Tuesday?\"",
        "Easiest close on this sheet. Call the direct line, then send the same message on WhatsApp.")]

    F += [bishop_card(
        3, "DELIVERANCE CHURCH UGANDA", 270, 270 * FEE,
        "Pr. Peter J. Idembe — General Overseer",
        ["+256 773 319 543", "+256 784 744 041"],
        "dcuganda@gmail.com",
        "Below Nsambya Sharing Hall, off Ggaba Road, Kampala. P.O. Box 25903.",
        "dcuganda.org",
        "270 congregations running since 1967, and the secretariat still reports on paper. An old, respected "
        "network with weak technology is exactly where SMS and attendance win. He will accept a 10-assembly pilot.",
        "\"Pr. Idembe, your secretariat reports on paper today. I can put all 270 congregations on one dashboard, "
        "and each assembly can SMS its own members. Let's start with 10 assemblies and judge it.\"",
        "Apostolic team: Kayiira, Tibarokora, Okello, Ongole, Obwana, Jjumba — any of them can get you to him.")]

    F += [PageBreak()]

    F += [bishop_card(
        4, "PAG — CENTRAL BUGANDA PASTORATE", 155, 155 * FEE,
        "Rev. Bishop Alex Ojera — Pastorate Bishop",
        ["+256 393 252 492  (PAG HQ)", "+256 414 220 138  (PAG HQ)",
         "Ask for: Bishop Ojera's office"],
        "info@paguganda.org",
        "Pastorate offices in Kampala city. PAG HQ: Plot 64 Luthuli Avenue, Bugolobi. P.O. Box 10113.",
        "paguganda.org/central-region-pastorate",
        "You do not need PAG's national leadership. PAG is 24 pastorates, and this one bishop alone holds "
        "<b>155 churches</b> across Kampala, Wakiso, Mukono, Luweero, Nakaseke, Mityana, Mpigi, Kayunga, "
        "Butambala, Mubende, Buikwe, Kasanda and Gomba.",
        "\"Bishop, I'm not asking for the whole of PAG — just your pastorate. 155 churches in Kampala and Wakiso. "
        "Fifteen minutes with you, and I'll come to your office.\"",
        "5 Assemblies · 29 pastors · 17 districts. The pastorate secretary is the person who can actually book you.")]

    F += [bishop_card(
        5, "UNITED APOSTOLIC CHURCH OF UGANDA", 654, 654 * FEE,
        "National office — ask for the General Overseer's office",
        ["+256 776 547 143", "+256 772 341 937", "+256 753 583 473"],
        "info@unitedapostolicchurchug.org",
        "Lubaga Road, Kampala.",
        "unitedapostolicchurchug.org",
        "654 established churches across 103 districts and 50,000+ members since 1996. The largest single "
        "network on this sheet that has no committee in front of the door. 654 × 17,000 = 11.1M of headroom.",
        "\"I've built a church system now used across Kampala. With 654 churches in 103 districts, you need one "
        "dashboard, not 654 phone calls. May I have fifteen minutes with the office?\"",
        "A referral from any pastor you already serve will move this faster than a cold call.")]

    F += [bishop_card(
        6, "VICTORY CHRISTIAN CENTRE  /  BORN AGAIN FAITH", 470, 470 * FEE,
        "Ap. Dr. Joseph Serwadda — Presiding Apostle; head of Born Again Faith (BAF)",
        ["0414 272 114  (Victory, Ndeeba)", "+256 773 089 129  (BAF secretariat)"],
        "secretariet@bornagainfauth.org",
        "Plot 849-850 near BMK, Masaka Road, Ndeeba, Kampala. BAF: Millennium Chambers, Entebbe Road.",
        "victoryuganda.org",
        "The single biggest prize: one yes is 470 branches <b>and</b> a national umbrella endorsement that opens "
        "every BAF member church. Also the hardest door this week — treat it as a long shot, never as the plan.",
        "\"Apostle, I'm a Ugandan founder building church software. I know your diary is closed — I'm asking for "
        "fifteen minutes, or for whoever in BAF handles member services.\"",
        "Do not spend Monday here. Send the letter, make the other seven calls, come back to it Thursday.")]

    F += [PageBreak()]

    F += [bishop_card(
        7, "FULL GOSPEL CHURCHES OF UGANDA", 1600, 1600 * FEE,
        "Ask for: the National Secretary (Stephen Ssebaggala) — not the archbishop",
        ["+256 414 540 437", "+256 414 535 630", "+256 755 923 876"],
        "via fullgospelchurchesofuganda.org/contact",
        "Plot 49-59 Makerere Hill Road, Kampala. P.O. Box 2560.",
        "fullgospelchurchesofuganda.org",
        "Claims 1,600 churches and runs a theological training arm — the biggest theoretical number on this sheet "
        "(27.2M at full activation). Realistically a January account, but the secretary is reachable today and "
        "the secretary is who schedules these things.",
        "\"I'm not asking for the archbishop. I'm asking for fifteen minutes with you, and a pilot with one "
        "region that you choose.\"",
        "Their own figure. Ask how many are currently active — that number is the one that matters.")]

    F += [bishop_card(
        8, "PENTECOSTAL MINISTRIES OF UGANDA (PMU)", 300, 300 * FEE,
        "National office (HQ Fort Portal) — ask for the Kampala branch leadership",
        ["No published direct line", "Start with the Kampala branch in person"],
        "via globalnetworkprayer.com",
        "HQ Fort Portal. Branches: Kabarole, Kamwenge, Kyenjojo, Bundibugyo, Kibale, Rakai, Gulu, Kitgum, "
        "Pader, Mbarara, Bushenyi, Kampala, Hoima, plus DRC.",
        "",
        "A ~300-church network licensed to operate countrywide, with a Kampala presence you can walk into — "
        "and almost nobody pitches them, so you will not be the fourth founder this month.",
        "\"You have around 300 churches from Fort Portal to Gulu. One system would let your office see every one "
        "of them. Who handles your records today?\"",
        "Lowest information on this sheet — confirm the Kampala contact before you travel.")]

    F += [section_head("G", "Where to find fifty more tonight", "two hours, no cost"), Spacer(1, 2.5 * mm)]
    F += [mini_table([
        ["Source", "What you get", "How"],
        ["paguganda.org — pastorate pages", "Every pastorate's bishop, district list and church count",
         "Read all 24 pastorates; each is 50–155 churches"],
        ["bornagainfaith.org/listings", "Member churches with contacts", "Filter Kampala, then look for multi-branch names"],
        ["churchguideuganda.com", "Churches by district", "Use district=Kampala, walk the list"],
        ["Google Maps", "Multi-branch churches you've never heard of",
         "Search \"church\" in Makindye, Nansana, Kira, Mukono — the words Ministries / Centre / Fellowship "
         "usually mean a network"],
    ], [46 * mm, 56 * mm, 80 * mm]), Spacer(1, 5 * mm)]
    F += [PageBreak()]

    # ── page: B-list + umbrellas ────────────────────────────────────────────
    F += [section_head("E", "B-LIST — one phone call each", "smaller networks, faster yes"), Spacer(1, 3 * mm)]
    F += [mini_table([
        ["Network", "Branches", "Who / number", "Where"],
        ["Redeemed Ministries (Grace Church)", "10–15",
         "+256 414 286 845<br/>+256 772 876 432",
         "P.O. Box 8266 Kampala — Ntinda, Kyebando, Wakiso, Wobulenzi, Gomba, Kirihura, Mbarara"],
        ["Holy Ghost Power Ministries", "several + Burundi",
         "Ps. Fred Byekwaso<br/>+256 772 615 130<br/>+256 772 639 984",
         "Mutundwe, 8 km south of Kampala — holygpc@yahoo.co.uk"],
        ["Kampala International Christian Centre", "multi-site",
         "0759 825 869", "10 Kisaasi–Kyanja Rd, Kampala"],
        ["Christian Life Church", "1 big + satellites",
         "Ps. Jackson Senyonga<br/>041 454 1269", "Plot 713 Bombo Road, Bwaise, Kampala"],
        ["Miracle Centre Cathedral", "1,000+ (claims vary)",
         "+256 772 662 926<br/>+256 772 451 708",
         "Kabaka's Lake, Kampala — r.kayanja@hotmail.com"],
        ["Kawempe Prayer Palace", "1 (450 members)",
         "Ps. Edward Lule<br/>+256 772 494 075", "Kawempe, Kampala — luled60@yahoo.com"],
        ["Luzira Healing Springs Church", "1",
         "+256 414 504 492", "Luzira, Kampala"],
    ], [50 * mm, 26 * mm, 42 * mm, 64 * mm]), Spacer(1, 5 * mm)]

    F += [section_head("F", "Umbrella bodies — one endorsement, many churches"), Spacer(1, 3 * mm)]
    F += [mini_table([
        ["Body", "Reach", "Contact", "Why it matters"],
        ["National Fellowship of Born Again Pentecostal Churches (NFBPC-U)", "50,000+ churches claimed",
         "nfbpc.secretariat@gmail.com<br/>Abp. Dr. Moses Odongo (GO)<br/>Bp. Dr. Africano Magyezi (GS)",
         "2,184 sub-county bishops · 202 district bishops · 60 provincial · 15 regional · 6 national. "
         "Archbishop's office: Plot 38 Bible House, Bombo Rd, Level 3. Secretariat: Balokole House, "
         "Kiwanga-Kasokoso, Mukono."],
        ["Born Again Faith (BAF)", "national umbrella",
         "+256 773 089 129<br/>secretariet@bornagainfauth.org",
         "Millennium Chambers, Entebbe Road. Apostle Serwadda presides. A district bishop can convene "
         "20–30 churches for you in a single meeting."],
    ], [46 * mm, 26 * mm, 46 * mm, 64 * mm]), Spacer(1, 5 * mm)]


    F += [callout("OBJECTIONS — SAY IT LIKE THIS", [
        "<b>\"We already use WhatsApp groups.\"</b>  WhatsApp can't tell you who attended, who is new, or who "
        "stopped coming — and it can't count your members for a report.",
        "<b>\"17,000 is too much per branch.\"</b>  It is once, not monthly. One funeral SMS to 300 members costs "
        "15,000. This replaces that, and 1,000 free SMS are included.",
        "<b>\"My pastors have no money.\"</b>  Start with 5 branches at 85,000. If the dashboard hasn't helped you "
        "in 30 days, don't bring the other 25.",
        "<b>\"Let me think about it.\"</b>  Fair. Let me register your HQ branch now and you judge it on your own "
        "attendance this Sunday.",
        "<b>\"Who else uses it?\"</b>  Name every church already live. Never inflate the number — pastors talk to "
        "each other, and one exaggeration ends eight relationships.",
    ]), Spacer(1, 5 * mm)]

    F += [PageBreak()]
    F += [section_head("H", "The standalone youth-leader hunt", "one person, one church, one decision"), Spacer(1, 3 * mm)]
    F += [p("No bishop, no umbrella, no committee. A lone youth leader or a young church planter decides "
            "for himself. There is no registry of these people — so this is not a list, it is a hunting "
            "system: seven places they gather, and what to do when you get there.", "body"), Spacer(1, 3 * mm)]
    F += [mini_table([
        ["Where they gather", "What you get", "How to work it"],
        ["<b>Campus Christian Unions</b><br/>MukCU +256 777 345 125, then Kyambogo, MUBS, KIU, Ndejje, "
         "Nkumba, UCU Mukono, Bugema, Victoria, Kampala University",
         "8–15 elected leaders per CU — and every one belongs to a church",
         "Attend a fellowship, ask for the chairperson or discipleship coordinator and take an "
         "<i>executive</i> slot, not a sermon slot. Ask each: \"which church do you come from, and who "
         "leads your youth?\""],
        ["<b>Young church planters</b><br/>Trinity Chapel (Macharias), Grace Church Kampala (Pius Muzingu), "
         "Road to Redemption (Ps. Sandra Baingana), New Wine Kampala (Ps. Kristine Wright, +256 78 420 24 40)",
         "The only standalone who decides <b>and pays</b> — same day",
         "Search Facebook/Instagram: church + Kampala/Nansana/Kira/Makindye/Mukono, under 5,000 followers, "
         "posting weekly, named young pastor. Church plants advertise because they are recruiting"],
        ["<b>Christian creators</b><br/>TikTok, Instagram, YouTube — #UgandaGospel, #Balokole, #KampalaChurch",
         "10k–300k of reach, no institution to ask",
         "Pay per activated church only. Never pay upfront for a post — a creator with a real commission "
         "will post three times"],
        ["<b>Youth camps</b><br/>Gold Youth Camps (vastgrace.org, 1,000 teens in 2026), Harvest Christian "
         "Ministries, CTMI Kampala camp 3–5 Sept 2026",
         "Youth leaders from 30 churches in one field for a week",
         "Offer a free 45-minute church-admin workshop. You leave with every leader's number"],
        ["<b>Bible colleges</b><br/>Kampala Evangelical School of Theology, Glad Tidings (Makerere Hill Rd)",
         "30–200 students, each already leading youth on weekends",
         "One 30-minute class visit beats a week of DMs"],
        ["<b>WhatsApp / Telegram youth groups</b>", "Admins with real reach",
         "Find public group links on church Instagram pages. Never spam the group — DM the admin only"],
        ["<b>School Christian clubs</b><br/>~3,970 schools with Scripture Union clubs",
         "Patron teachers and student leaders, funnelled into churches by design",
         "Slowest to pay, but a 22-year-old club leader is a customer for a decade"],
    ], [56 * mm, 46 * mm, 80 * mm]), Spacer(1, 4 * mm)]

    F += [callout("FILTER FIRST — ONLY WORK THE 3s AND ABOVE", [
        "Does he lead or plant an actual church (not just a ministry brand)?  <b>+2</b>",
        "Is the church 100+, or the youth group 30+?  <b>+1</b>",
        "Has he posted in the last 14 days?  <b>+1</b>   ·   Is he in Kampala, Wakiso or Mukono?  <b>+1</b>",
        "A 5 is a same-day visit. A 2 gets one DM and nothing more. Never spend an hour on a 2.",
    ], fill=PAPER, border=MUTED)]

    F += [PageBreak()]
    F += [section_head("I", "What you send, and what you give", "20 DMs a day is the whole engine"), Spacer(1, 3 * mm)]

    F += [callout("THE THREE-MESSAGE SCRIPT", [
        "<b>1. The DM (3 lines, no more):</b> \"I'm a Ugandan founder — I built a church system that keeps "
        "members, tracks attendance and sends SMS to youth at 50/= each. I'm giving it free to 30 youth "
        "leaders this month for honest feedback. Are you the one who handles youth records at your church?\"",
        "<b>2. The voice note (only if he replies):</b> 40 seconds, your real voice, not text. Who you are, "
        "one sentence on what it does, \"give me 10 minutes and I'll show you on my screen.\"",
        "<b>3. The meeting ask:</b> \"When are you at church? I'll come to you — Tuesday evening or "
        "Wednesday after 4.\" Never sell in a DM.",
        "<b>In person:</b> laptop open, import 300 names from his paper register live, send an SMS to his own "
        "phone, show the usher passkey. Then, and only then, the 17,000.",
    ], fill=colors.HexColor("#EFF4EC"), border=GREEN), Spacer(1, 4 * mm)]

    F += [mini_table([
        ["A bishop gets", "A standalone youth leader gets"],
        ["Diocese dashboard and volume pricing", "<b>\"Founding Youth Leader\"</b> title, certificate, and a WhatsApp group with the other 29"],
        ["1,000 free SMS credits", "Free account for his youth ministry once the pastor approves"],
        ["A meeting in his office", "<b>3,000/= commission</b> per activated church through his own invite code"],
        ["An invoice", "Paid the <b>same day</b>, every single time"],
    ], [91 * mm, 91 * mm]), Spacer(1, 4 * mm)]

    F += [callout("THE DAILY QUOTA — THIS IS THE WHOLE ENGINE", [
        "20 DMs sent  →  ~5 replies  →  ~2 meetings  →  <b>1 church activated</b>. That is 5–7 churches a "
        "week, alone, with no bishop and no permission.",
        "Two months of that discipline and the 89-activation problem is gone permanently. Three ambassadors "
        "doing the same is 75 a month.",
        "<b>Speed of payment is your reputation.</b> A leader paid within the hour tells ten friends; one "
        "who waits a week tells nobody and stops.",
        "For <i>this</i> week, work only two of the seven grounds: young church planters near Makerere, "
        "Kyambogo and MUBS, plus one campus CU executive meeting. Everything else is the 30-day engine.",
    ], fill=SAND, border=ACCENT)]

    F += [Spacer(1, 3 * mm)]
    F += [p("DM TRACKER — 20 a day. Write the handle, score him out of 5, and never work a 2 again.", "label"),
          Spacer(1, 2 * mm)]
    rows = [["Name / handle", "Church or ministry", "Score /5", "Sent", "Reply", "Met", "Paid"]]
    rows += [["", "", "", "", "", "", ""] for _ in range(11)]
    dm = Table(rows, colWidths=[40 * mm, 52 * mm, 16 * mm, 18 * mm, 18 * mm, 18 * mm, 20 * mm],
               rowHeights=[7 * mm] + [8 * mm] * 11)
    dm.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), SAND),
        ("GRID", (0, 0), (-1, -1), 0.4, LINE),
        ("BOX", (0, 0), (-1, -1), 0.8, MUTED),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 7.2),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 2 * mm),
    ]))
    F += [dm]

    F += [PageBreak()]
    F += [section_head("J", "Social channels — where the youth already are", "reach, not customers"), Spacer(1, 3 * mm)]
    F += [p("Two different things: youth-heavy <b>churches</b> (organisations that can buy) and "
            "<b>creators/artists</b> (attention that can amplify). Do not confuse them.", "body"), Spacer(1, 3 * mm)]
    F += [p("YOUTH-HEAVY CHURCHES AND MINISTRIES", "label"), Spacer(1, 1.5 * mm)]
    F += [mini_table([
        ["Organisation", "Why it fits", "How to approach"],
        ["<b>Phaneroo Ministries</b><br/>Apostle Grace Lubega, founded 2014",
         "Predominantly <b>youth</b>; built for TikTok/Instagram/WhatsApp distribution; runs <b>600+ manifest "
         "centres</b> — a ready-made 600-branch network that matches your diocese tier",
         "Do not chase the apostle. Ask for the office that manages <b>manifest centres</b>, and pitch the "
         "centre-leader dashboard. @apostlegracelubega (IG)"],
        ["<b>Light the World Church</b><br/>Nansana — Ps. Wilson Bugembe",
         "Youth-magnet church (~6,000 capacity) led by a major gospel artist with a young celebrity-adjacent following",
         "Church office in Nansana. He collaborates publicly and answers"],
        ["<b>Watoto Church</b><br/>17–18 campuses, ~30,000 weekly",
         "Cell-based, youth-strong, highly centralised — one ops decision covers every campus",
         "HQ Kampala — ask for the communications or IT lead, not a campus pastor"],
        ["<b>House of Prayer Ministries</b><br/>Ps. Aloysius Bugingo",
         "Huge congregation plus Salt Media (radio + TV) — reach far beyond the building",
         "Approach the media/ministry office; the media arm is the better conversation"],
        ["<b>Christian Life Church</b><br/>Makerere-Kavule — Ps. Jackson Senyonga",
         "Large youth and campus presence, strong TV output",
         "Church office; ask who runs the youth and campus ministry"],
    ], [46 * mm, 70 * mm, 66 * mm]), Spacer(1, 4 * mm)]

    F += [p("GOSPEL ARTISTS AND CREATORS — VERIFY BEFORE YOU SPEND AN HOUR", "label"), Spacer(1, 1.5 * mm)]
    F += [mini_table([
        ["Name", "Handle", "Reach", "Read this"],
        ["Weird Pastor (Wisdom Mwongyera)", "@weird_pastor (TikTok)", "~2–2.5M TikTok", "Biggest Christian-adjacent creator in Uganda. One video beats any bishop's network"],
        ["Baby Gloria", "search on platform", "~1.4M TikTok", "Gospel/lifestyle, clean brand, very young audience"],
        ["Irene Namatovu", "search on platform", "~750K TikTok", "Faith-driven, loyal audience"],
        ["Anointed one", "@praise420", "~1.6M TikTok", "Faith-branded handle, youth audience"],
        ["Millionaires girlfriend", "@lifestyleforever2", "~370–400K TikTok", "Christian lifestyle vlogs, female youth audience"],
        ["Levixone", "@levixone (IG)", "~245–270K IG, <b>0.2% engagement</b>", "Biggest gospel name among campusers — and the weakest engagement on this list. Pay per result only"],
        ["malaikatenshi", "@malaikatenshi", "~207K TikTok", "Award-winning MC — good for event nights"],
        ["Jehovah Shalom Acapella", "@jehovah_shalom_acapella_ug", "~98.6K IG", "Choir with church-network credibility"],
        ["Coopy Bly", "@coopybly · coopyblymusic@gmail.com", "~27K IG", "Runs @yimba_uganda and @backyard_256 — partner, not a promoter"],
        ["Rachael Nduhukire", "@rachaelnduhukire", "~31K, <b>8–10% engagement</b>", "Small and genuinely engaged — will outperform the 245K account"],
    ], [38 * mm, 44 * mm, 34 * mm, 66 * mm]), Spacer(1, 4 * mm)]

    F += [callout("THE ENGAGEMENT RULE — 245K AT 0.2% IS WORSE THAN 31K AT 9%", [
        "Check three things on the profile itself: <b>engagement rate</b> (under 1% is a dead audience), "
        "<b>comment language</b> (real church audiences write in Luganda — Amina, Kale, Weebale), and "
        "<b>last post date</b> (no post in 30 days = no audience).",
        "<b>Never pay upfront for a post.</b> 3,000 per activated church, paid same day, code in the bio. "
        "If a creator demands cash before posting, walk away — there are fifty more.",
        "<b>Offer artists a free account for their home church plus commission</b>, not money. Artists have "
        "church homes and church networks; that is the asset, not the follower count.",
        "Expect 0.5–2% conversion from attention: a 2M-follower video might yield 3–10 churches. Real, but "
        "never your primary channel.",
    ], fill=PAPER, border=MUTED)]

    F += [PageBreak()]
    F += [section_head("K", "Tally — fill this in as the week moves"), Spacer(1, 3 * mm)]
    rows = [["Bishop / network", "Branches", "Called", "Meeting", "Agreed", "Paid"],
            ["", "", "", "", "", ""], ["", "", "", "", "", ""], ["", "", "", "", "", ""],
            ["", "", "", "", "", ""], ["", "", "", "", "", ""], ["", "", "", "", "", ""],
            ["", "", "", "", "", ""], ["", "", "", "", "", ""]]
    tally = Table(rows, colWidths=[72 * mm, 22 * mm, 20 * mm, 22 * mm, 22 * mm, 24 * mm],
                  rowHeights=[8 * mm] + [11 * mm] * 8)
    tally.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), SAND),
        ("GRID", (0, 0), (-1, -1), 0.4, LINE),
        ("BOX", (0, 0), (-1, -1), 0.8, MUTED),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 7.5),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 2.5 * mm),
    ]))
    F += [tally, Spacer(1, 3 * mm)]
    F += [p("Total branches invited:  __________     Total activated:  __________     "
            f"Collected:  UGX ____________  /  {money(TARGET)}", "cellb")]
    F += [Spacer(1, 6 * mm)]
    F += [p("NOTES — what each man actually said, in his words. Bring this back to the next call.", "label"),
          Spacer(1, 3 * mm)]
    for _ in range(11):
        F += [Table([[""]], colWidths=[182 * mm], rowHeights=[8 * mm],
                    style=TableStyle([("LINEBELOW", (0, 0), (-1, -1), 0.4, LINE)]))]
    F += [Spacer(1, 4 * mm)]
    F += [callout("BEFORE YOU SLEEP, EVERY NIGHT THIS WEEK", [
        "1. Every booked meeting confirmed on WhatsApp the same evening.",
        "2. Every bishop who said \"send me something\" got it within an hour — not tomorrow.",
        "3. Every church that paid is live and can send SMS before you sleep. Money taken and church locked "
        "out is how a network of 258 churches turns against you in one day.",
    ], fill=colors.HexColor("#EFF4EC"), border=GREEN)]

    doc.build(F)
    print(f"wrote {OUT}")

if __name__ == "__main__":
    build()
