# pyrefly: ignore [missing-import]
import pytest
# pyrefly: ignore [missing-import]
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_get_automation_rules_seeded(client: AsyncClient, auth_headers: dict):
    response = await client.get("/api/automations/rules", headers=auth_headers)
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
    assert len(data) >= 2
    # Verifica che la regola predefinita dell'ufficio tecnico sia presente
    assert any("Ufficio Tecnico" in r["name"] or "Acquisti" in r["name"] for r in data)


@pytest.mark.asyncio
async def test_create_and_toggle_automation_rule(client: AsyncClient, auth_headers: dict):
    new_rule = {
        "name": "Test Rule: Superamento Ore",
        "description": "Regola di test per automazione",
        "trigger_type": "budget_hours_exceeded",
        "trigger_config": {"threshold_pct": 85},
        "conditions": {"department": "produzione"},
        "action_type": "send_notification",
        "action_config": {"title": "Allerta Ore Test", "message": "Superate ore"},
        "is_active": True,
    }
    create_res = await client.post("/api/automations/rules", headers=auth_headers, json=new_rule)
    assert create_res.status_code == 200
    rule = create_res.json()
    assert rule["name"] == new_rule["name"]
    assert rule["is_active"] is True
    rule_id = rule["id"]

    # Toggle
    toggle_res = await client.patch(f"/api/automations/rules/{rule_id}/toggle", headers=auth_headers)
    assert toggle_res.status_code == 200
    assert toggle_res.json()["is_active"] is False

    # Delete
    del_res = await client.delete(f"/api/automations/rules/{rule_id}", headers=auth_headers)
    assert del_res.status_code == 200


@pytest.mark.asyncio
async def test_get_automation_logs(client: AsyncClient, auth_headers: dict):
    response = await client.get("/api/automations/logs", headers=auth_headers)
    assert response.status_code == 200
    assert isinstance(response.json(), list)


@pytest.mark.asyncio
async def test_task_completion_triggers_automated_todo(client: AsyncClient, auth_headers: dict):
    # 0. Inizializza le regole di default
    init_rules = await client.get("/api/automations/rules", headers=auth_headers)
    assert init_rules.status_code == 200

    # 1. Crea commessa
    p_res = await client.post(
        "/api/projects",
        headers=auth_headers,
        json={
            "name": "Commessa Impianto Packaging",
            "client": "Barilla",
            "code": "BAR-2026-01",
        }
    )
    assert p_res.status_code == 201
    proj_id = p_res.json()["id"]

    # 2. Crea fase ufficio tecnico (es. Progettazione 3D)
    t_res = await client.post(
        f"/api/projects/{proj_id}/tasks",
        headers=auth_headers,
        json={
            "text": "Progettazione 3D e Layout Esecutivo",
            "department": "ufficio_tecnico",
            "duration": 5,
            "start_date": "2026-09-20",
            "planned_hours": 40.0,
            "progress": 0.2,
        }
    )
    assert t_res.status_code == 201
    task_id = t_res.json()["id"]

    # 3. Completa la fase al 100%
    up_res = await client.put(
        f"/api/projects/{proj_id}/tasks/{task_id}",
        headers=auth_headers,
        json={
            "progress": 1.0,
            "completed": 1,
        }
    )
    assert up_res.status_code == 200

    # 4. Verifica che sia stato creato automaticamente un TODO
    todos_res = await client.get("/api/todos", headers=auth_headers)
    assert todos_res.status_code == 200
    todos = todos_res.json()
    auto_todo = next((td for td in todos if "BAR-2026-01" in td["title"] or "BAR-2026-01" in (td.get("content") or "")), None)
    assert auto_todo is not None
    assert "materiali" in auto_todo["title"].lower() or "componenti" in auto_todo["title"].lower()


@pytest.mark.asyncio
async def test_automation_with_specific_workers_and_labels(client: AsyncClient, auth_headers: dict):
    """Verifica che una regola con filtro per addetti specifici scatti SOLO se la fase è affidata a quell'addetto,
    e che le etichette in formato [Nome Fase] e [Codice Commessa] vengano valorizzate correttamente."""
    # 1. Crea commessa di test
    p_res = await client.post(
        "/api/projects",
        headers=auth_headers,
        json={
            "name": "Commessa Linea Robotica",
            "client": "Ferrero",
            "code": "ROB-2026-99",
        }
    )
    assert p_res.status_code == 201
    proj_id = p_res.json()["id"]

    # 2. Crea regola vincolata SOLO all'addetto 'Marco (UT)' con etichette visive
    rule_res = await client.post(
        "/api/automations/rules",
        headers=auth_headers,
        json={
            "name": "Solo Addetto Marco ➔ Task Controllo",
            "trigger_type": "phase_completed",
            "conditions": {
                "department": "specific_workers",
                "workers": ["Marco (UT)"]
            },
            "action_type": "create_todo",
            "action_config": {
                "title": "Collaudo Eseguito: [Nome Fase] ([Codice Commessa])",
                "content": "La fase [Nome Fase] della commessa [Codice Commessa] è stata completata con successo.",
                "assignee_department": "acquisti",
                "due_days": 2,
            },
            "is_active": True,
        }
    )
    assert rule_res.status_code == 200
    rule_id = rule_res.json()["id"]

    # 3. Crea fase affidata a un DIVERSO addetto ('Luigi (UT)')
    t_other = await client.post(
        f"/api/projects/{proj_id}/tasks",
        headers=auth_headers,
        json={
            "text": "Montaggio Telaio Luigi",
            "department": "produzione",
            "workers": ["Luigi (UT)"],
            "duration": 3,
            "start_date": "2026-09-22",
            "planned_hours": 20.0,
            "progress": 0.0,
        }
    )
    assert t_other.status_code == 201
    t_other_id = t_other.json()["id"]

    # Completa la fase di Luigi
    await client.put(
        f"/api/projects/{proj_id}/tasks/{t_other_id}",
        headers=auth_headers,
        json={"progress": 1.0, "completed": 1}
    )

    # Verifica che NON sia stato creato alcun TODO per 'Montaggio Telaio Luigi'
    todos_res1 = await client.get("/api/todos", headers=auth_headers)
    assert todos_res1.status_code == 200
    assert not any("Montaggio Telaio Luigi" in td["title"] for td in todos_res1.json())

    # 4. Crea fase affidata a 'Marco (UT)'
    t_marco = await client.post(
        f"/api/projects/{proj_id}/tasks",
        headers=auth_headers,
        json={
            "text": "Progettazione Circuiti Marco",
            "department": "ufficio_tecnico",
            "workers": ["Marco (UT)"],
            "duration": 3,
            "start_date": "2026-09-22",
            "planned_hours": 15.0,
            "progress": 0.0,
        }
    )
    assert t_marco.status_code == 201
    t_marco_id = t_marco.json()["id"]

    # Completa la fase di Marco
    await client.put(
        f"/api/projects/{proj_id}/tasks/{t_marco_id}",
        headers=auth_headers,
        json={"progress": 1.0, "completed": 1}
    )

    # 5. Verifica che il TODO sia stato generato E che le etichette siano state sostituite
    todos_res2 = await client.get("/api/todos", headers=auth_headers)
    assert todos_res2.status_code == 200
    matching_todo = next((td for td in todos_res2.json() if "Progettazione Circuiti Marco" in td["title"]), None)
    assert matching_todo is not None
    # Verifica sostituzione etichetta [Codice Commessa] -> ROB-2026-99
    assert "ROB-2026-99" in matching_todo["title"]
    assert "ROB-2026-99" in matching_todo["content"]

    # Cleanup regola di test
    await client.delete(f"/api/automations/rules/{rule_id}", headers=auth_headers)


@pytest.mark.asyncio
async def test_action_create_todo_and_notify_on_phase_started(client: AsyncClient, auth_headers: dict):
    """Verifica l'azione combinata create_todo_and_notify quando si avvia una fase (phase_started)."""
    p_res = await client.post(
        "/api/projects",
        headers=auth_headers,
        json={
            "name": "Commessa Impianto Eolico",
            "client": "Enel Green Power",
            "code": "EOL-2026-55",
        }
    )
    assert p_res.status_code == 201
    proj_id = p_res.json()["id"]

    # Crea regola di avvio lavori con azione doppia
    rule_res = await client.post(
        "/api/automations/rules",
        headers=auth_headers,
        json={
            "name": "Avvio Lavori ➔ TODO + Alert PM",
            "trigger_type": "phase_started",
            "conditions": {},
            "action_type": "create_todo_and_notify",
            "action_config": {
                "title": "Verifica Materiali Avvio: [Nome Fase]",
                "content": "La fase [Nome Fase] è partita. Verificare componentistica.",
                "assignee_department": "produzione",
                "due_days": 1,
                "notify_title": "🚀 Allerta Avvio [Nome Fase] ([Codice Commessa])",
                "notify_message": "Inizio attività registrato per la commessa [Codice Commessa].",
                "recipient_role": "pm",
            },
            "is_active": True,
        }
    )
    assert rule_res.status_code == 200
    rule_id = rule_res.json()["id"]

    # Crea fase a progress 0
    t_res = await client.post(
        f"/api/projects/{proj_id}/tasks",
        headers=auth_headers,
        json={
            "text": "Assemblaggio Alternatore",
            "department": "produzione",
            "duration": 4,
            "start_date": "2026-09-25",
            "planned_hours": 30.0,
            "progress": 0.0,
        }
    )
    assert t_res.status_code == 201
    task_id = t_res.json()["id"]

    # Avvia la fase registrando avanzamento 0.1
    up_res = await client.put(
        f"/api/projects/{proj_id}/tasks/{task_id}",
        headers=auth_headers,
        json={"progress": 0.1}
    )
    assert up_res.status_code == 200

    # 1. Verifica creazione TODO
    todos = (await client.get("/api/todos", headers=auth_headers)).json()
    assert any("Assemblaggio Alternatore" in td["title"] for td in todos)

    # 2. Verifica creazione Notifica in-app
    notifs = (await client.get("/api/notifications", headers=auth_headers)).json()
    assert any("EOL-2026-55" in n["title"] or "EOL-2026-55" in (n.get("message") or "") for n in notifs)

    # Cleanup regola di test
    await client.delete(f"/api/automations/rules/{rule_id}", headers=auth_headers)


@pytest.mark.asyncio
async def test_trigger_phase_progress_reached(client: AsyncClient, auth_headers: dict):
    """Verifica il trigger phase_progress_reached al raggiungimento della soglia percentuale."""
    p_res = await client.post(
        "/api/projects",
        headers=auth_headers,
        json={
            "name": "Commessa Stazione Elettrica",
            "client": "Terna",
            "code": "TER-2026-10",
        }
    )
    assert p_res.status_code == 201
    proj_id = p_res.json()["id"]

    # Regola per soglia 50%
    rule_res = await client.post(
        "/api/automations/rules",
        headers=auth_headers,
        json={
            "name": "SAL 50% ➔ Notifica Terna",
            "trigger_type": "phase_progress_reached",
            "trigger_config": {"target_progress": 50},
            "conditions": {},
            "action_type": "send_notification",
            "action_config": {
                "notify_title": "📈 SAL 50%: [Nome Fase]",
                "notify_message": "La commessa [Codice Commessa] ha raggiunto il 50% di avanzamento.",
                "recipient_role": "pm",
            },
            "is_active": True,
        }
    )
    assert rule_res.status_code == 200
    rule_id = rule_res.json()["id"]

    # Crea fase a progress 20%
    t_res = await client.post(
        f"/api/projects/{proj_id}/tasks",
        headers=auth_headers,
        json={
            "text": "Posa Cavi Alta Tensione",
            "department": "produzione",
            "duration": 5,
            "start_date": "2026-09-25",
            "planned_hours": 50.0,
            "progress": 0.2,
        }
    )
    assert t_res.status_code == 201
    task_id = t_res.json()["id"]

    # Porta l'avanzamento al 60% (superando il 50%)
    await client.put(
        f"/api/projects/{proj_id}/tasks/{task_id}",
        headers=auth_headers,
        json={"progress": 0.6}
    )

    # Verifica la notifica
    notifs = (await client.get("/api/notifications", headers=auth_headers)).json()
    assert any("TER-2026-10" in (n.get("message") or "") for n in notifs)

    # Cleanup regola di test
    await client.delete(f"/api/automations/rules/{rule_id}", headers=auth_headers)


@pytest.mark.asyncio
async def test_action_create_calendar_event(client: AsyncClient, auth_headers: dict):
    """Verifica l'azione create_calendar_event: creazione automatica di evento a calendario su completamento fase."""
    # 1. Crea commessa
    p_res = await client.post(
        "/api/projects",
        headers=auth_headers,
        json={
            "name": "Commessa Linea Imbottigliamento",
            "client": "San Pellegrino",
            "code": "SAN-2026-88",
        }
    )
    assert p_res.status_code == 201
    proj_id = p_res.json()["id"]

    # 2. Crea regola con azione create_calendar_event
    rule_res = await client.post(
        "/api/automations/rules",
        headers=auth_headers,
        json={
            "name": "Collaudo a Calendario su Fine Fase",
            "trigger_type": "phase_completed",
            "conditions": {},
            "action_type": "create_calendar_event",
            "action_config": {
                "event_title": "Collaudo Consegna: [Nome Fase] ([Codice Commessa])",
                "event_description": "Riunione collaudo per la commessa [Codice Commessa]. Fase: [Nome Fase].",
                "event_date_type": "task_end_date",
                "event_days_offset": 1,
                "event_color": "#0284c7",
                "calendar_attendees": "pm",
                "notify_attendees": True,
            },
            "is_active": True,
        }
    )
    assert rule_res.status_code == 200
    rule_id = rule_res.json()["id"]

    # 3. Crea fase
    t_res = await client.post(
        f"/api/projects/{proj_id}/tasks",
        headers=auth_headers,
        json={
            "text": "Taratura Valvole Elettroniche",
            "department": "produzione",
            "duration": 4,
            "start_date": "2026-09-22",
            "end_date": "2026-09-26",
            "planned_hours": 32.0,
            "progress": 0.0,
        }
    )
    assert t_res.status_code == 201
    task_id = t_res.json()["id"]

    # 4. Completa la fase (progress: 1.0, completed: 1)
    await client.put(
        f"/api/projects/{proj_id}/tasks/{task_id}",
        headers=auth_headers,
        json={"progress": 1.0, "completed": 1}
    )

    # 5. Verifica creazione evento in calendario
    cal_res = await client.get("/api/calendar/events", headers=auth_headers)
    assert cal_res.status_code == 200
    events = cal_res.json()
    matching_event = next((ev for ev in events if "SAN-2026-88" in ev["title"]), None)
    assert matching_event is not None
    assert "Taratura Valvole Elettroniche" in matching_event["title"]
    assert "SAN-2026-88" in (matching_event.get("description") or "")

    # Cleanup regola di test
    await client.delete(f"/api/automations/rules/{rule_id}", headers=auth_headers)
