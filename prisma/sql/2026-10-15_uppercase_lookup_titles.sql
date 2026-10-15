-- Lookup lists in uppercase, matching the rest of the student record:
-- disability and religion titles, country names and nationalities.
-- Only rows not already uppercase are touched. Idempotent: safe to run more
-- than once. Students reference these rows by id, so nothing else changes.

UPDATE disability SET title = UPPER(title), updatedAt = NOW(3)
WHERE BINARY title <> BINARY UPPER(title);

UPDATE religion SET title = UPPER(title), updatedAt = NOW(3)
WHERE BINARY title <> BINARY UPPER(title);

UPDATE country SET longName = UPPER(longName), updatedAt = NOW(3)
WHERE BINARY longName <> BINARY UPPER(longName);

UPDATE country SET nationality = UPPER(nationality), updatedAt = NOW(3)
WHERE nationality IS NOT NULL AND BINARY nationality <> BINARY UPPER(nationality);

-- Spelling corrections. Each only applies while the misspelt title exists
-- and the correct one doesn't, so it never creates a duplicate.
UPDATE religion r SET r.title = 'BUDDHIST', r.updatedAt = NOW(3)
WHERE UPPER(TRIM(r.title)) = 'BHUDIST'
  AND NOT EXISTS (SELECT 1 FROM (SELECT title FROM religion) x WHERE UPPER(TRIM(x.title)) = 'BUDDHIST');

UPDATE religion r SET r.title = 'HINDU', r.updatedAt = NOW(3)
WHERE UPPER(TRIM(r.title)) = 'HINDIST'
  AND NOT EXISTS (SELECT 1 FROM (SELECT title FROM religion) x WHERE UPPER(TRIM(x.title)) = 'HINDU');

UPDATE disability d SET d.title = 'BLIND IN ONE EYE', d.updatedAt = NOW(3)
WHERE UPPER(TRIM(d.title)) = 'BLIND IN ON EYE'
  AND NOT EXISTS (SELECT 1 FROM (SELECT title FROM disability) x WHERE UPPER(TRIM(x.title)) = 'BLIND IN ONE EYE');
