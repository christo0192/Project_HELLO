/** Seeds a demo role with a screening question template. */
import { supabase } from '../src/lib/supabase.js';

const role = {
  title: 'Frontend Engineer',
  jd: 'Build and maintain React/TypeScript web applications. Work with REST APIs, state management, and modern UI tooling.',
  required_skills: ['React', 'TypeScript', 'JavaScript', 'CSS', 'REST APIs', 'Git'],
  screening_template: [
    { id: 'q1', question: 'Can you walk me through your experience with React and TypeScript?', weight: 3 },
    { id: 'q2', question: 'Tell me about a challenging UI problem you solved recently and how you approached it.', weight: 3 },
    { id: 'q3', question: 'How do you typically manage state in a larger React application?', weight: 2 },
    { id: 'q4', question: 'What is your experience working with REST APIs and handling errors on the frontend?', weight: 2 },
    { id: 'q5', question: 'What are you looking for in your next role, and what is your notice period?', weight: 1 },
  ],
};

const { data, error } = await supabase.from('roles').insert(role).select().single();
if (error) {
  console.error('Seed failed:', error.message);
  process.exit(1);
}
console.log('✓ Seeded role:', data.id, '—', data.title);
