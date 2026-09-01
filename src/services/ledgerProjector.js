/** Event-sourced read-model projector. Applies one event per transaction. */
export async function projectNextEvent(client, event, { projectorName = "ledger-projector" } = {}) {
  await client.query("BEGIN");
  try {
    const seq = Number(event.sequence_no ?? event.sequence ?? 0);
    const type = event.event_type ?? event.type;
    const payload = event.payload || {};
    const entityId = payload.entityId || payload.entity_id || event.aggregate_id;
    if (type === "CashReserved") await client.query("INSERT INTO ledger.account_balances_view(entity_id,reserved_cash,last_event_seq) VALUES($1,$2,$3) ON CONFLICT(entity_id) DO UPDATE SET reserved_cash=ledger.account_balances_view.reserved_cash+$2,last_event_seq=$3,updated_at=clock_timestamp()", [entityId, Number(payload.amount || 0), seq]);
    else if (type === "CashReleased") await client.query("UPDATE ledger.account_balances_view SET reserved_cash=reserved_cash-$2,last_event_seq=$3,updated_at=clock_timestamp() WHERE entity_id=$1", [entityId, Number(payload.amount || 0), seq]);
    else if (type === "FillReceived") await client.query("INSERT INTO ledger.positions_view(entity_id,instrument,quantity,average_price,last_event_seq) VALUES($1,$2,$3,$4,$5) ON CONFLICT(entity_id,instrument) DO UPDATE SET quantity=ledger.positions_view.quantity+$3,last_event_seq=$5,updated_at=clock_timestamp()", [entityId, payload.instrument || payload.symbol, Number(payload.quantity || payload.units || 0), payload.price || null, seq]);
    else if (type === "OrderAccepted") await client.query("INSERT INTO ledger.account_balances_view(entity_id,last_event_seq) VALUES($1,$2) ON CONFLICT(entity_id) DO UPDATE SET last_event_seq=$2,updated_at=clock_timestamp()", [entityId, seq]);
    await client.query("INSERT INTO ledger.projector_checkpoints(projector_name,last_event_seq) VALUES($1,$2) ON CONFLICT(projector_name) DO UPDATE SET last_event_seq=GREATEST(ledger.projector_checkpoints.last_event_seq,$2),updated_at=clock_timestamp()", [projectorName, seq]);
    await client.query("COMMIT"); return { applied: true, sequence: seq };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}

export async function projectEvents(client, events, options = {}) {
  const result = []; for (const event of [...events].sort((a, b) => Number(a.sequence_no ?? a.sequence) - Number(b.sequence_no ?? b.sequence))) result.push(await projectNextEvent(client, event, options)); return result;
}
