/** Creates/updates the "Program Advisor - India" role for Interview Kickstart. */
import { supabase } from '../src/lib/supabase.js';

const JD = `Program Advisor - India — Bengaluru — Interview Kickstart

Interview Kickstart is a premier career transformation platform turbocharging tech careers through AI upskilling (40+ courses, 600+ FAANG+ instructors, 25,000+ professionals advanced).

What the role entails:
- Connect with customers to understand their needs as they prepare for tech interviews.
- Guide candidates on course selection and prerequisites.
- Communicate product offerings and how they align with candidate goals.
- Offer personalized strategies and resources to help candidates succeed.
- Maintain relationships throughout the preparation journey; track progress and give feedback.
- Stay abreast of industry trends and interview processes; contribute to training materials.

Requirements:
- BE (preferably Computer Science), MCA preferred.
- 1-5 years in a customer-facing or advisor role, preferably education or career services.
- Strong understanding of technical interview processes and preparation strategies.
- Excellent communication skills, verbal and written.
- Ability to build rapport with customers and provide tailored support.
- Experience with CRM software and managing candidate databases.`;

const role = {
  title: 'Program Advisor - India',
  jd: JD,
  required_skills: [
    'Customer-facing / advisory experience (1-5 yrs)',
    'Excellent verbal English communication & rapport',
    'Career / education services background (preferred)',
    'Understanding of technical interview prep (nice to have)',
    'CRM / candidate database experience',
  ],
  // Dynamic-within-flow: Maya phrases each topic live and adapts to the resume.
  screening_template: [
    { id: 'intro', question: 'Brief introduction — ask the candidate to tell you about themselves and what they are doing currently.' },
    { id: 'yoe', question: 'Total years of professional experience, and how many of those were in a customer-facing or advisory role.', mandatory: true, weight: 2 },
    { id: 'advisory', question: "The candidate's customer-facing / advisory / counselling / sales experience — have them walk through a relevant role and how they supported customers.", weight: 3 },
    { id: 'comm', question: 'A situational communication & rapport question — e.g. how they handle a hesitant or confused customer and build trust over a call.', weight: 3 },
    { id: 'motivation', question: 'Why this Program Advisor role at Interview Kickstart, and what they understand about advising candidates preparing for tech interviews.', weight: 2 },
    { id: 'why_left', question: 'Reason for leaving their current or previous organization.', mandatory: true, weight: 1 },
    { id: 'ctc', question: 'Current CTC and expected CTC, plus notice period.', mandatory: true, weight: 1 },
    { id: 'location', question: 'Whether they are in Bengaluru or open to relocating, and comfortable with an onsite/hybrid work mode.', weight: 1 },
  ],
};

const { data: existing } = await supabase
  .from('roles')
  .select('id')
  .eq('title', role.title)
  .maybeSingle();

if (existing) {
  const { error } = await supabase.from('roles').update(role).eq('id', existing.id);
  if (error) { console.error('update failed:', error.message); process.exit(1); }
  console.log('✓ Updated role:', existing.id, '—', role.title);
} else {
  const { data, error } = await supabase.from('roles').insert(role).select().single();
  if (error) { console.error('insert failed:', error.message); process.exit(1); }
  console.log('✓ Created role:', data.id, '—', role.title);
}
