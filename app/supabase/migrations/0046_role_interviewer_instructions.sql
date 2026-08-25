-- Store recruiter-authored guidance that is shown in the generated voice prompt.
-- It is role-scoped, editable by the existing roles RBAC surface, and optional.
alter table screening_v2.roles
  add column if not exists interviewer_instructions text not null default '';

comment on column screening_v2.roles.interviewer_instructions is
  'Recruiter-authored interviewing guidance included in the generated screening prompt.';
