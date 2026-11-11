-- Several demo projects: Riverside Clinic (the equipment rental) and Harbor Street Offices
-- (library pieces across three floors). Only Riverside has an equipment booking, so
-- a demo seed may come without one; reset_demo already skips the booking when there is none.
alter table public.demo_seeds alter column booking drop not null;
