export async function audit(db, actorId, action, entity, entityId, meta = {}) {
  await db.query(
    'INSERT INTO audit_log (actor_id, action, entity, entity_id, meta) VALUES ($1,$2,$3,$4,$5)',
    [actorId || null, action, entity, entityId ? String(entityId) : null, meta],
  );
}
