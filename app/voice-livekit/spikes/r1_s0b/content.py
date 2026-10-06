"""Pinned S0-B role-play content copied from R1 plan final section 5.

This is spike data, not a production content contract.  D2 remains pending,
so facts that require sales-lead approval are explicit placeholders rather
than invented details.
"""
from __future__ import annotations

from dataclasses import dataclass


SCRIPTED_LINES = {
    "L-OPEN": "Hi {first_name}, I'm Christy, an AI interviewer from Interview Kickstart, and I'll be running your first-round interview for the Sales Program Advisor role. It takes about twenty minutes. We'll spend a few minutes getting to know you, then I'll switch into a short sales role-play where I play a prospective learner, and we'll finish with a couple of minutes for your questions. Let's start: could you walk me through your background, especially any sales or customer-facing work you've done?",
    "L-TRANSITION": "Thank you, {first_name}. We'll now move to the role-play. I'll play a prospective learner so we can evaluate how you handle a real sales call. The learner is {lead_name} from {lead_city}, who filled in a form on our website about the Data Science course a few days ago. You're the Program Advisor calling her back. Your goal is to understand her needs and help her reach a decision, as you would on a real call, using the course details from your preparation guide. It will run for about twelve to fourteen minutes, and I'll stay in character until I say, 'Let's pause the role-play here.' When you're ready, just say 'ready' and she'll pick up.",
    "L-TIME-CUE": "Just so you know, I've only got a couple of minutes before my next call.",
    "L-EXIT": "Let's pause the role-play here. I'm stepping out of the learner's role now; this is Christy, your interviewer, again. Thank you, that's the end of the role-play.",
    "L-WRAP": "Before we finish, do you have any questions about the role or the next steps?",
    "L-NO-FEEDBACK": "I'm not able to share how it went. The hiring team will review the full interview and get back to you.",
    "L-FAQ-DEFER": "That's a good question for the hiring team; they'll follow up with you on it.",
    "L-CLOSE": "Thank you for your time today, {first_name}. The hiring team will review your interview and get back to you. You can close this window now. Goodbye.",
    "L-ASIDE-COACH": "Quick note from Christy, your interviewer: in this role-play you're the Program Advisor and I'm the learner, {lead_name}. She enquired about the Data Science course and you're calling her back. Please carry on as you would on a real call.",
    "L-MUTE": "This is Christy. It looks like your microphone may be muted. Please unmute when you're ready.",
    "L-SIL-IB": "Are you still with me, {first_name}?",
    "L-SIL-RP1": "Hello? Are you still there?",
    "L-SIL-RP2": "This is Christy, your interviewer. It sounds like we may have lost you. I'll wait a few more seconds.",
    "L-SIL-END": "I'm going to end the interview here as we seem to have lost the connection. The hiring team will be in touch. Goodbye.",
    "L-REJOIN": "Welcome back, {first_name}. Let's pick up where we left off. The learner is back on the line.",
    "L-SYSTEM-STOP": "I'm sorry, {first_name}, we need to stop here because of a technical problem on our side. This won't count against you, and the hiring team will send you a new link. Goodbye.",
    "L-FILLER-INTERVIEWER": "Let me think about that for a second.",
    "L-FILLER-LEARNER": "Hmm, one second...",
}

WORLD_FACTS = {
    "version": "r1_world_facts_seed_from_prep_deck",
    "founded": "Interview Kickstart was founded in 2014.",
    "coverage": "Interview prep spans 18 engineering domains plus ML/DS career-transition courses.",
    "instructors": "750+ instructors are from Google, Facebook, Amazon and Netflix.",
    "data_science_modules": [
        "Python Fundamentals", "Database & SQL", "Math for DS & ML", "EDA",
        "Classical ML", "Advanced ML & DL", "Big Data Analysis",
        "Data Visualization & Storytelling", "Capstone",
    ],
    "list_price_usd": 9000,
    "duration": "6 months",
    "target_audience": "People preparing for data-science career transitions.",
    "career_outcomes": "Career-transition support and interview preparation for data roles.",
    "usps": ["structured curriculum", "instructor experience", "capstone work", "interview preparation"],
    "urgency_levers": ["dated career trigger", "cohort timing once approved", "enrolment deadline once approved"],
    "discount_plan_mapping": "TODO_D2: Sales lead must approve $500/$1,000/$1,500 mapping to plans.",
    "cohort_dates": "TODO_D2: Sales lead must approve cohort start, enrolment deadline, seats and active offer.",
    "weekly_hours": "TODO_D2: Sales lead must approve weekly-hours range.",
    "delivery_format": "TODO_D2: Sales lead must approve live versus recorded details.",
    "projects": "TODO_D2: Sales lead must approve project details.",
    "does_not_offer": "TODO_D2: Sales lead must provide the does-not-offer list.",
}


@dataclass(frozen=True)
class Persona:
    id: str
    name: str
    age: int
    city: str
    profile: str
    pickup: str
    surface_needs: dict[str, str]
    deep_needs: dict[str, str]
    decision_maker: str
    prior_learning: str
    variants: tuple[dict[str, str], ...]

    @property
    def public_card(self) -> str:
        return (
            f"You are {self.name}, {self.age}, in {self.city}. {self.profile} "
            "You submitted an inbound website form a few days ago. You know only that the "
            "Data Science course is around $9,000 and about 6 months. "
            f"Surface answers: H1={self.surface_needs['H1']} H2={self.surface_needs['H2']} "
            f"H3={self.surface_needs['H3']} Prior learning: {self.prior_learning}. "
            "Public fact answers: manageable monthly budget is around $500-700 a month; "
            "decision timeline is within a couple of weeks; competitors are a couple of bootcamps "
            "not compared in detail; heard via a webinar; success is a data role within a year. "
            "For anything else say: I'm not sure, I haven't thought about that."
        )


PERSONAS = (
    Persona("P1", "Meera Iyer", 33, "Edison, NJ", "Eight years in pharma operations and quality; Excel-heavy and no coding.", "Hello? Yes, this is Meera speaking.",
            {"H1": "Just exploring options.", "H2": "I've tried a bit of online stuff.", "H3": "My schedule is pretty packed."},
            {"H1": "Plant consolidation is due next year; my role has been stagnant for 3 years.", "H2": "I quit a free Python course after 3 weeks without structure and fear I am too old to start coding.", "H3": "I have two kids, so evenings and weekends only; shared finances mean I need monthly instalments."},
            "husband", "Tried a free Python course.", ({"name": "Meera Iyer", "city": "Edison, NJ", "employer_type": "pharma operations"}, {"name": "Meera Shah", "city": "Princeton, NJ", "employer_type": "quality operations"}, {"name": "Meera Patel", "city": "New Brunswick, NJ", "employer_type": "life sciences"})),
    Persona("P2", "Ananya Rao", 24, "Austin, TX", "MS in Information Systems (May), contract reporting analyst, 150+ data-scientist applications and two final-round losses.", "Hello? Yes, this is Ananya speaking.",
            {"H1": "The job search is okay.", "H2": "I get some interviews.", "H3": "Money's a bit tight."},
            {"H1": "My contract renewal is decided in about 6 months and I want a DS role by then.", "H2": "I keep failing ML and technical rounds; self-study is not working.", "H3": "I have student loans, so instalments only."},
            "father", "Self-study for ML and technical interviews.", ({"name": "Ananya Rao", "city": "Austin, TX", "employer_type": "contract analytics"}, {"name": "Ananya Singh", "city": "Dallas, TX", "employer_type": "reporting"}, {"name": "Ananya Gupta", "city": "Houston, TX", "employer_type": "business intelligence"})),
    Persona("P3", "Kavya Menon", 29, "Charlotte, NC", "Four years as an analyst at a bank using SQL, Excel, Tableau and some Python.", "Hello? Yes, this is Kavya speaking.",
            {"H1": "Thinking about my next step.", "H2": "I already know a lot of the basics.", "H3": "Work gets crazy sometimes."},
            {"H1": "I was passed over for an internal DS role for not enough ML depth; the next opening is in 6-8 months.", "H2": "I fear the course repeats SQL basics, and restructuring rumours make me doubt DS is safe.", "H3": "Quarter-end crunches are hard; I pay myself and need instalments."},
            "husband", "SQL, Excel, Tableau and some Python at work.", ({"name": "Kavya Menon", "city": "Charlotte, NC", "employer_type": "banking"}, {"name": "Kavya Nair", "city": "Raleigh, NC", "employer_type": "financial services"}, {"name": "Kavya Pillai", "city": "Atlanta, GA", "employer_type": "risk analytics"})),
    Persona("P4", "Shalini Verma", 31, "Boston, MA", "Postdoc in computational biology with strong Python, R and statistics.", "Hello? Yes, this is Shalini speaking.",
            {"H1": "Weighing a few paths.", "H2": "Industry interviews are different.", "H3": "I'm still running experiments."},
            {"H1": "My funding ends in about 8 months and the academic market is bleak.", "H2": "I was rejected after an industry case round; I lack production ML, SQL and interview skills and feel like an outsider.", "H3": "My postdoc budget is tight, so I need instalments."},
            "partner", "Strong Python, R and statistics in research.", ({"name": "Shalini Verma", "city": "Boston, MA", "employer_type": "computational biology"}, {"name": "Shalini Kapoor", "city": "Cambridge, MA", "employer_type": "academic research"}, {"name": "Shalini Joshi", "city": "Somerville, MA", "employer_type": "biotech research"})),
)

OBJECTION_LINES = {
    "Q-A": "Is it live classes or recorded?",
    "F3_PRIMARY": "There's so much free stuff on YouTube and Coursera — why pay?",
    "F3_PUSH": "Will this actually get me a job, with all these layoffs?",
    "F2_PRIMARY": "My schedule is already packed; I'm not sure I can keep up for six months.",
    "F2_PUSH": "What happens if I fall behind?",
    "F1_ANCHOR": "$9,000 is a lot. I've heard people got it for around $7,000 — can you do that?",
    "F1_COUNTER": "Can you do a little better than that?",
    "Q-B": "What would I actually build in the course?",
    "F4_PRIMARY": "Let me think about it — maybe I'll join the next cohort.",
    "F4_PUSH": "I'd also need to talk to my {decision_maker}.",
}

COMMITMENT_LINES = {
    "STRONG": "Okay, let's do it. Send me the enrolment link for that plan and I'll pay the deposit today.",
    "MEDIUM": "Let's book a call on Thursday at 7 PM with my {decision_maker} so we can decide.",
    "WEAK": "Let me think about it. Just email me the details and I'll get back to you.",
}
