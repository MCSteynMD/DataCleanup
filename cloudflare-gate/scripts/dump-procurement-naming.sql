-- Dump procurement naming specs from the live D1 (other machine / Master Drilling account).
-- Run:
--   wrangler d1 execute procurement-config-db --remote --json --file=scripts/dump-procurement-naming.sql
-- Save the JSON as cloudflare-gate/data/procurement-naming-dump.json
-- then: node scripts/build-naming-backbone.mjs
--
-- Tables are new_categories / new_lists / new_options on current procurement-config-db.
-- If those are empty, switch to categories / lists / options.

SELECT id,
       name,
       parent_id AS parentId,
       sort_order AS sortOrder,
       child_label AS childLabel,
       starts_with AS startsWith
  FROM new_categories
 ORDER BY id;

SELECT id,
       category_id AS categoryId,
       name,
       is_required AS isRequired,
       prefix,
       sort_order AS sortOrder,
       dependent_on_option_id AS dependentOnOptionId
  FROM new_lists
 ORDER BY category_id, sort_order, id;

SELECT id,
       list_id AS listId,
       value,
       sort_order AS sortOrder
  FROM new_options
 ORDER BY list_id, sort_order, id;
