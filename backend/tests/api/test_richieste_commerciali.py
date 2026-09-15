import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_create_richiesta_commerciale(client: AsyncClient, auth_headers: dict):
    """Verifica creazione di una nuova Richiesta Commerciale con articoli."""
    payload = {
        "title": "Fornitura carpenteria metallica ATEX",
        "cliente": "Acme Industrial S.p.A.",
        "descrizione": "Richiesta urgente di offerta con certificati collaudo inclusi.",
        "numero_offerta": "OFF-2026-001",
        "articoli": [
            {
                "titolo": "Flangia tornita DN100 PN16",
                "descrizione": "Materiale AISI 316L, finitura 1.6 Ra",
                "is_atex": True,
                "is_standard": False
            },
            {
                "titolo": "Tubazione saldata 3 pollici",
                "descrizione": "Spessore 3mm, decappata e passivata",
                "is_atex": False,
                "is_standard": True
            }
        ]
    }
    resp = await client.post("/api/richieste-commerciali/", headers=auth_headers, json=payload)
    assert resp.status_code == 201, f"Expected 201, got {resp.status_code}: {resp.text}"
    data = resp.json()

    assert data["cliente"] == "Acme Industrial S.p.A."
    assert data["title"] == "Fornitura carpenteria metallica ATEX"
    assert data["status"] in ("in_lavorazione", "aperta")
    assert len(data["articoli"]) == 2
    assert data["articoli"][0]["titolo"] == "Flangia tornita DN100 PN16"
    assert "id" in data


@pytest.mark.asyncio
async def test_get_richieste_commerciali_list(client: AsyncClient, auth_headers: dict):
    """Verifica elenco richieste e lettura."""
    # Crea richiesta
    await client.post(
        "/api/richieste-commerciali/",
        headers=auth_headers,
        json={
            "title": "Richiesta Lista Test",
            "cliente": "Cliente Test Lista",
            "descrizione": "Descrizione test lista"
        }
    )

    resp = await client.get("/api/richieste-commerciali/", headers=auth_headers)
    assert resp.status_code == 200
    items = resp.json()
    assert isinstance(items, list)
    assert len(items) >= 1
    assert any(r["cliente"] == "Cliente Test Lista" for r in items)


@pytest.mark.asyncio
async def test_update_richiesta_and_diff_tracking(client: AsyncClient, auth_headers: dict):
    """
    Verifica che la modifica dei campi tracci l'intero storico (diff chain)
    con valore originale (old_value / steps[0]), valore precedente e nuovo valore.
    """
    # 1. Creazione iniziale
    create_resp = await client.post(
        "/api/richieste-commerciali/",
        headers=auth_headers,
        json={
            "title": "Titolo Originale",
            "cliente": "Cliente Diff Test",
            "descrizione": "Descrizione commerciale iniziale"
        }
    )
    assert create_resp.status_code == 201
    rc_id = create_resp.json()["id"]

    # 2. Prima modifica
    update_1 = await client.put(
        f"/api/richieste-commerciali/{rc_id}",
        headers=auth_headers,
        json={
            "title": "Titolo Modificato 1",
            "descrizione": "Descrizione revisione 1"
        }
    )
    assert update_1.status_code == 200
    data_1 = update_1.json()
    assert data_1["title"] == "Titolo Modificato 1"
    modifiche = data_1.get("modifiche") or {}
    assert "title" in modifiche
    assert modifiche["title"]["old_value"] == "Titolo Originale"
    assert modifiche["title"]["new_value"] == "Titolo Modificato 1"
    assert len(modifiche["title"]["steps"]) == 2

    # 3. Seconda modifica successiva (l'originale deve rimanere intatto!)
    update_2 = await client.put(
        f"/api/richieste-commerciali/{rc_id}",
        headers=auth_headers,
        json={
            "title": "Titolo Modificato 2"
        }
    )
    assert update_2.status_code == 200
    data_2 = update_2.json()
    assert data_2["title"] == "Titolo Modificato 2"
    modifiche_2 = data_2.get("modifiche") or {}
    assert modifiche_2["title"]["old_value"] == "Titolo Originale"
    assert modifiche_2["title"]["new_value"] == "Titolo Modificato 2"
    # La catena degli step traccia tutti e 3 i passaggi (Originale -> Modificato 1 -> Modificato 2)
    assert len(modifiche_2["title"]["steps"]) == 3
    assert modifiche_2["title"]["steps"][0]["value"] == "Titolo Originale"
    assert modifiche_2["title"]["steps"][1]["value"] == "Titolo Modificato 1"
    assert modifiche_2["title"]["steps"][2]["value"] == "Titolo Modificato 2"


@pytest.mark.asyncio
async def test_article_lifecycle_and_modifiche(client: AsyncClient, auth_headers: dict):
    """Verifica aggiunta, modifica con diff tracking e cancellazione di un articolo."""
    # 1. Crea richiesta base
    rc_resp = await client.post(
        "/api/richieste-commerciali/",
        headers=auth_headers,
        json={"title": "Test Articoli", "cliente": "Cliente Articoli"}
    )
    assert rc_resp.status_code == 201
    rc_id = rc_resp.json()["id"]

    # 2. Aggiungi articolo con costo
    add_art = await client.post(
        f"/api/richieste-commerciali/{rc_id}/articoli",
        headers=auth_headers,
        json={
            "titolo": "Vite M8x30 Inox",
            "costo": 1.50,
            "descrizione": "A4-70"
        }
    )
    assert add_art.status_code == 201
    art_id = add_art.json()["id"]

    # 3. Modifica articolo (es. rettifica costo e descrizione)
    edit_art = await client.put(
        f"/api/richieste-commerciali/{rc_id}/articoli/{art_id}",
        headers=auth_headers,
        json={
            "costo": 2.20,
            "descrizione": "A4-80 ad alta resistenza"
        }
    )
    assert edit_art.status_code == 200
    art_data = edit_art.json()
    assert art_data["costo"] == 2.20
    art_modifiche = art_data.get("modifiche") or {}
    assert "costo" in art_modifiche
    assert "1.50" in str(art_modifiche["costo"]["old_value"])
    assert "2.20" in str(art_modifiche["costo"]["new_value"])

    # 4. Elimina articolo
    del_art = await client.delete(
        f"/api/richieste-commerciali/{rc_id}/articoli/{art_id}",
        headers=auth_headers
    )
    assert del_art.status_code == 204


@pytest.mark.asyncio
async def test_status_workflow_transitions(client: AsyncClient, auth_headers: dict):
    """Verifica l'aggiornamento di stato nel workflow (in_lavorazione -> manca_listino -> completata)."""
    rc_resp = await client.post(
        "/api/richieste-commerciali/",
        headers=auth_headers,
        json={"title": "Test Workflow", "cliente": "Cliente Workflow"}
    )
    assert rc_resp.status_code == 201
    rc_id = rc_resp.json()["id"]
    assert rc_resp.json()["status"] == "in_lavorazione"

    # Aggiorna stato a manca_listino
    patch_resp = await client.put(
        f"/api/richieste-commerciali/{rc_id}",
        headers=auth_headers,
        json={"status": "manca_listino"}
    )
    assert patch_resp.status_code == 200
    assert patch_resp.json()["status"] == "manca_listino"

    # Approvazione finale/completamento
    patch_appr = await client.put(
        f"/api/richieste-commerciali/{rc_id}",
        headers=auth_headers,
        json={"status": "completata"}
    )
    assert patch_appr.status_code == 200
    assert patch_appr.json()["status"] == "completata"


def test_filter_visible_modifiche_by_role():
    """Verifica che l'admin veda tutte le modifiche (incluso costo), mentre per gli altri il costo sia protetto."""
    from app.api.richieste_commerciali import _filter_visible_modifiche
    from app.models.user import User, UserRole

    admin_user = User(id="admin-uuid", username="admin_boss", role=UserRole.ADMIN)
    comm_user = User(id="comm-uuid", username="commerciale_user", role=UserRole.EDITOR)

    modifiche_data = {
        "title": {
            "field": "title",
            "old_value": "Titolo A",
            "new_value": "Titolo B",
            "author_id": "comm-uuid",
            "steps": [{"value": "Titolo A", "author_id": "comm-uuid"}, {"value": "Titolo B", "author_id": "comm-uuid"}]
        },
        "costo": {
            "field": "costo",
            "old_value": "10.00 €",
            "new_value": "8.50 €",
            "author_id": "acquisti-uuid",
            "steps": [{"value": "10.00 €", "author_id": "acquisti-uuid"}, {"value": "8.50 €", "author_id": "acquisti-uuid"}]
        }
    }

    # 1. Admin vede tutto (title E costo)
    admin_visible = _filter_visible_modifiche(modifiche_data, role="admin", current_user=admin_user)
    assert "title" in admin_visible
    assert "costo" in admin_visible

    # 2. Commerciale vede il titolo (in quanto autore) ma il costo fornitore è ESCLUSO
    comm_visible = _filter_visible_modifiche(modifiche_data, role="commerciale", current_user=comm_user)
    assert "title" in comm_visible
    assert "costo" not in comm_visible

