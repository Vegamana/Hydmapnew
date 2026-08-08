-- =====================================================================
-- 0004_seed.sql — a handful of real Hyderabad coordinates so the map,
-- clustering and rent pulse have something to show on a fresh database.
-- Safe to skip in production.
-- =====================================================================

insert into public.listings (title, type, price, lat, lng, bhk, furnishing, deposit, owner_email, locality, description)
values
  ('2BHK near Hitec City metro',      'rent',      32000, 17.4485, 78.3908, '2', 'semi',        100000, 'owner1@example.com', 'Hitec City',  'Walk to Cyber Towers. Covered parking, 24x7 water.'),
  ('Sunny 3BHK in Kondapur',          'rent',      45000, 17.4615, 78.3600, '3', 'furnished',   150000, 'owner2@example.com', 'Kondapur',    'Corner flat, cross ventilation, gated community.'),
  ('1BHK studio, Gachibowli',         'rent',      21000, 17.4400, 78.3489, '1', 'furnished',    60000, 'owner3@example.com', 'Gachibowli',  'Ideal for a single working professional.'),
  ('Sharing room in Madhapur',        'sharing',   12000, 17.4483, 78.3915, '2', 'furnished',    25000, 'owner4@example.com', 'Madhapur',    'One bed free in a 2BHK. Female only.'),
  ('3BHK for sale, Kokapet',          'sale',    9500000, 17.4100, 78.3300, '3', 'unfurnished',      0, 'owner5@example.com', 'Kokapet',     'East facing, 1650 sqft, ready to move.'),
  ('Paid 28k for 2BHK, Manikonda',    'rent_paid', 28000, 17.4040, 78.3690, '2', 'semi',         90000, 'owner6@example.com', 'Manikonda',   'Reporting what I actually pay, for reference.'),
  ('2BHK near Ameerpet metro',        'rent',      24000, 17.4374, 78.4487, '2', 'unfurnished',  80000, 'owner7@example.com', 'Ameerpet',    'Two minutes from the metro entrance.'),
  ('Spacious 2BHK, Begumpet',         'rent',      27500, 17.4400, 78.4600, '2', 'semi',         85000, 'owner8@example.com', 'Begumpet',    'Quiet lane, close to the railway station.'),
  ('1BHK in Secunderabad',            'rent',      15000, 17.4399, 78.4983, '1', 'unfurnished',  45000, 'owner9@example.com', 'Secunderabad','Near Parade Ground metro.'),
  ('Sharing bed near Charminar',      'sharing',    7000, 17.3616, 78.4747, '2', 'furnished',    15000, 'owner10@example.com','Charminar',   'Old city, walkable to everything.')
on conflict do nothing;

update public.listings
   set expires_at = coalesce(expires_at, created_at + interval '30 days');
