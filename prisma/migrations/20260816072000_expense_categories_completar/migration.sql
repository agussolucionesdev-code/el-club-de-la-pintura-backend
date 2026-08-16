-- Completa la lista de categorías con las que un comercio de pinturería usa a
-- diario y faltaban.
--
-- El disparador fue un test: cargaba un gasto con categoría "INSUMOS" y la
-- validación nueva lo rechazó. La validación hizo lo suyo — lo que estaba mal
-- era la lista, que había heredado sólo las seis que el frontend tenía
-- cableadas. Insumos, alquiler y publicidad son gastos reales de este negocio.
INSERT INTO "ExpenseCategory" ("key", "label", "color", "isSystem", "isActive", "sortOrder", "createdAt", "updatedAt")
VALUES
  ('INSUMOS',   'Insumos y consumibles', '#14b8a6', true, true, 25, NOW(), NOW()),
  ('ALQUILER',  'Alquiler',              '#a855f7', true, true, 15, NOW(), NOW()),
  ('MARKETING', 'Publicidad',            '#ec4899', true, true, 60, NOW(), NOW())
ON CONFLICT ("key") DO UPDATE
  SET "isSystem" = true,
      "isActive" = true,
      -- Si el backfill ya la había creado desde datos viejos, se le pone su
      -- nombre y su color de verdad en lugar del gris genérico.
      "label"    = EXCLUDED."label",
      "color"    = EXCLUDED."color",
      "sortOrder"= EXCLUDED."sortOrder",
      "updatedAt"= NOW();
