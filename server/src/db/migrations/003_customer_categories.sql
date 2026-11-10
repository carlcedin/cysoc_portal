-- Customer categories: the CySOC service lines a customer belongs to. A customer can be in several.
ALTER TABLE tenants ADD COLUMN categories text[] NOT NULL DEFAULT '{}';
ALTER TABLE tenants ADD CONSTRAINT tenants_categories_valid
  CHECK (categories <@ ARRAY['TSAM','TMDR','DDoS','TSN','TSN+','VA','PAM']::text[]);

-- Backfill only where the existing data says so clearly; set the rest under Administration > Tenants.
UPDATE tenants SET categories = ARRAY(SELECT DISTINCT c FROM unnest(ARRAY[
    CASE WHEN service ILIKE '%TSAM%' THEN 'TSAM' END,
    CASE WHEN service ILIKE '%TMDR%' OR service ILIKE '%MDR%' THEN 'TMDR' END,
    CASE WHEN array_to_string(services, ' ') ILIKE '%DDoS%' THEN 'DDoS' END,
    CASE WHEN array_to_string(services, ' ') ILIKE '%Vulnerability%' THEN 'VA' END,
    CASE WHEN array_to_string(services, ' ') ILIKE '%PAM%' THEN 'PAM' END
  ]) AS c WHERE c IS NOT NULL ORDER BY c);
