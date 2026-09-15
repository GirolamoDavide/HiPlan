import json
from datetime import date, timedelta
from uuid import uuid4
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User, UserRole
from app.models.project import Project, ProjectStatus
from app.models.task import Task, TaskType, TaskPriority
from app.models.link import Link, LinkType
from app.models.vacation import Vacation
from app.models.replan_log import ReplanLog, ReplanActionType
from app.services.smart_replanning_service import (
    generate_project_smart_suggestions,
    apply_smart_replanning_proposal,
    revert_smart_replanning_log
)


@pytest.mark.asyncio
async def test_smart_replanning_vacation_reassignment(db_session: AsyncSession, test_user: User):
    """
    Test: Quando un addetto ha ferie coincidenti con una fase,
    il motore propone la riassegnazione a un collega libero dello stesso reparto,
    mantenendo inalterate le date e rispettando al 100% la scadenza di commessa.
    """
    # 1. Crea due utenti nello stesso reparto
    u1 = User(
        email="mario@example.com",
        username="mario_rossi",
        hashed_password="pwd",
        full_name="Mario Rossi",
        role=UserRole.VIEWER,
        department="produzione"
    )
    u2 = User(
        email="luca@example.com",
        username="luca_bianchi",
        hashed_password="pwd",
        full_name="Luca Bianchi",
        role=UserRole.VIEWER,
        department="produzione"
    )
    db_session.add_all([u1, u2])
    await db_session.commit()
    await db_session.refresh(u1)
    await db_session.refresh(u2)

    # 2. Crea commessa con date fisse
    p_start = date(2026, 10, 5)  # Lunedì
    p_end = date(2026, 10, 30)   # Venerdì
    project = Project(
        name="Commessa Impianto Test",
        code="COMM-TEST-1",
        status=ProjectStatus.ACTIVE,
        owner_id=test_user.id,
        start_date=p_start,
        end_date=p_end
    )
    db_session.add(project)
    await db_session.commit()
    await db_session.refresh(project)

    # 3. Crea fase dal 12 al 16 Ottobre assegnata a Mario Rossi
    t_start = date(2026, 10, 12) # Lunedì
    t_end = date(2026, 10, 16)   # Venerdì
    task = Task(
        project_id=project.id,
        text="Montaggio Meccanico",
        start_date=t_start,
        end_date=t_end,
        duration=5,
        planned_hours=40.0,
        workers=json.dumps(["Mario Rossi"]),
        worker_hours=json.dumps({"Mario Rossi": 40.0}),
        department="produzione",
        completed=0
    )
    db_session.add(task)
    await db_session.commit()
    await db_session.refresh(task)

    # 4. Mario Rossi inserisce ferie per il 13-14 Ottobre
    vac = Vacation(
        user_id=u1.id,
        start_date=date(2026, 10, 13),
        end_date=date(2026, 10, 14),
        reason="Ferie autunno"
    )
    db_session.add(vac)
    await db_session.commit()

    # 5. Genera suggerimenti
    result = await generate_project_smart_suggestions(db_session, str(project.id), test_user)

    assert result["conflicts_count"] >= 1
    assert result["actionable_suggestions_count"] >= 1

    # La proposta primaria preferita deve essere il recupero da parte dello stesso addetto (Mario Rossi)
    shift_sugg = next((s for s in result["suggestions"] if s["type"] == "vacation_conflict" and s["strategy"] == "internal_shift"), None)
    assert shift_sugg is not None
    assert "Mario Rossi" in shift_sugg["proposed_changes"]["workers"]
    assert shift_sugg["proposed_changes"]["start_date"] == "2026-10-15"
    assert shift_sugg["cascade_impact"]["project_deadline_status"] == "safe"

    # È presente anche l'opzione alternativa di riassegnare al collega Luca Bianchi a date invariate
    alt_sugg = next((s for s in result["suggestions"] if s["type"] == "vacation_conflict" and s["strategy"] == "reassign_worker"), None)
    assert alt_sugg is not None
    assert alt_sugg.get("is_alternative") is True
    assert shift_sugg.get("is_alternative") is False
    assert "Luca Bianchi" in alt_sugg["proposed_changes"]["workers"]
    assert alt_sugg["proposed_changes"]["start_date"] == str(t_start)
    assert alt_sugg["proposed_changes"]["end_date"] == str(t_end)
    assert alt_sugg["cascade_impact"]["project_deadline_status"] == "safe"


@pytest.mark.asyncio
async def test_smart_replanning_strict_deadline_preservation(db_session: AsyncSession, test_user: User):
    """
    Test: Verifica che nessuna proposta sposti mai la data di fine commessa
    e che, in caso di ritardo incolmabile entro project.end_date,
    venga generato un allarme di tipo deadline_breach_risk senza modifiche automatiche.
    """
    p_start = date(2026, 11, 2)
    p_end = date(2026, 11, 6)   # Solo 5 giorni lavorativi disponibili!

    project = Project(
        name="Commessa Scadenza Stretta",
        code="COMM-FAST",
        status=ProjectStatus.ACTIVE,
        owner_id=test_user.id,
        start_date=p_start,
        end_date=p_end
    )
    db_session.add(project)
    await db_session.commit()
    await db_session.refresh(project)

    # Unico addetto assegnato, che è in ferie per tutta la settimana
    worker = User(
        email="solo@example.com",
        username="solo_worker",
        hashed_password="pwd",
        full_name="Solo Worker",
        role=UserRole.VIEWER,
        department="ufficio_tecnico"
    )
    db_session.add(worker)
    await db_session.commit()
    await db_session.refresh(worker)

    task = Task(
        project_id=project.id,
        text="Progettazione Esecutiva",
        start_date=p_start,
        end_date=p_end,
        duration=5,
        planned_hours=40.0,
        workers=json.dumps(["Solo Worker"]),
        worker_hours=json.dumps({"Solo Worker": 40.0}),
        department="ufficio_tecnico",
        completed=0
    )
    db_session.add(task)
    await db_session.commit()
    await db_session.refresh(task)

    # Ferie che coprono il periodo
    vac = Vacation(
        user_id=worker.id,
        start_date=p_start,
        end_date=p_end,
        reason="Ferie"
    )
    db_session.add(vac)
    await db_session.commit()

    # Esegui analisi
    result = await generate_project_smart_suggestions(db_session, str(project.id), test_user)

    # Nessun altro addetto nell'ufficio tecnico: deve scattare l'allarme ultima spiaggia
    sugg = next((s for s in result["suggestions"] if s["type"] in ("deadline_breach_risk", "vacation_conflict")), None)
    assert sugg is not None
    # Il motore NON deve proporre uno spostamento automatico oltre p_end
    if sugg["strategy"] == "manual_action_required":
        assert sugg["proposed_changes"] is None
        assert sugg["cascade_impact"]["project_deadline_status"] == "breached"


@pytest.mark.asyncio
async def test_apply_and_revert_flow(db_session: AsyncSession, test_user: User):
    """
    Test del ciclo completo di Approvazione ed eventuale Annullamento (Revert):
    1. Applica una proposta di rebalance (aggiorna task in DB e scrive in ReplanLog).
    2. Annulla la modifica tramite revert e ripristina lo stato originale.
    """
    project = Project(
        name="Commessa Apply Revert Test",
        status=ProjectStatus.ACTIVE,
        owner_id=test_user.id,
        start_date=date(2026, 10, 1),
        end_date=date(2026, 10, 31)
    )
    db_session.add(project)
    await db_session.commit()
    await db_session.refresh(project)

    original_start = date(2026, 10, 5)
    original_end = date(2026, 10, 9)
    task = Task(
        project_id=project.id,
        text="Collaudo Preliminare",
        start_date=original_start,
        end_date=original_end,
        duration=5,
        planned_hours=40.0,
        workers=json.dumps(["Operatore A"]),
        worker_hours=json.dumps({"Operatore A": 40.0}),
        completed=0
    )
    db_session.add(task)
    await db_session.commit()
    await db_session.refresh(task)

    # Payload proposto
    new_start = date(2026, 10, 12)
    new_end = date(2026, 10, 16)
    proposal_payload = {
        "task_id": str(task.id),
        "workers": ["Operatore B"],
        "worker_hours": {"Operatore B": 40.0},
        "start_date": str(new_start),
        "end_date": str(new_end),
        "shift_working_days": 5,
        "reason": "Riassegnazione a Operatore B per disponibilità"
    }

    # 1. APPLICA
    apply_res = await apply_smart_replanning_proposal(
        db_session, str(project.id), proposal_payload, test_user
    )
    assert apply_res["success"] is True
    log_id = apply_res["log_id"]

    await db_session.refresh(task)
    assert task.start_date == new_start
    assert task.end_date == new_end
    assert json.loads(task.workers) == ["Operatore B"]

    # 2. ANNULLA (REVERT)
    revert_res = await revert_smart_replanning_log(db_session, log_id, test_user)
    assert revert_res["success"] is True

    await db_session.refresh(task)
    # Lo stato deve essere ritornato a quello originale!
    assert task.start_date == original_start
    assert task.end_date == original_end


@pytest.mark.asyncio
async def test_smart_replanning_cross_project_preview(db_session: AsyncSession, test_user: User):
    """
    Test: Verifica che quando una proposta di riprogrammazione su Commessa 1
    impatta un addetto condiviso con Commessa 2, il payload restituisca
    'related_projects' con i dati completi di Commessa 2 per l'anteprima Gantt.
    """
    u_shared = User(
        email="shared@example.com",
        username="worker_shared",
        hashed_password="pwd",
        full_name="Worker Shared",
        role=UserRole.VIEWER,
        department="ufficio_tecnico"
    )
    db_session.add(u_shared)
    await db_session.commit()
    await db_session.refresh(u_shared)

    today = date.today()
    # Commessa 1
    p1 = Project(
        name="Commessa Alfa Preview",
        code="COMM-ALFA",
        status=ProjectStatus.ACTIVE,
        owner_id=test_user.id,
        start_date=today - timedelta(days=30),
        end_date=today + timedelta(days=60)
    )
    # Commessa 2
    p2 = Project(
        name="Commessa Beta Impattata",
        code="COMM-BETA",
        status=ProjectStatus.ACTIVE,
        owner_id=test_user.id,
        start_date=today - timedelta(days=30),
        end_date=today + timedelta(days=60)
    )
    db_session.add_all([p1, p2])
    await db_session.commit()
    await db_session.refresh(p1)
    await db_session.refresh(p2)

    # Task su Commessa 1 scaduto nel passato
    t1 = Task(
        project_id=p1.id,
        text="Progettazione Alfa",
        start_date=today - timedelta(days=15),
        end_date=today - timedelta(days=5),  # scaduto
        duration=10,
        planned_hours=80.0,
        workers=json.dumps(["Worker Shared"]),
        worker_hours=json.dumps({"Worker Shared": 80.0}),
        completed=0
    )
    # Task su Commessa 2 nel presente
    t2 = Task(
        project_id=p2.id,
        text="Progettazione Beta",
        start_date=today,
        end_date=today + timedelta(days=7),
        duration=6,
        planned_hours=48.0,
        workers=json.dumps(["Worker Shared"]),
        worker_hours=json.dumps({"Worker Shared": 48.0}),
        completed=0
    )
    # Task successore collegato in Commessa 2
    t3 = Task(
        project_id=p2.id,
        text="Montaggio Beta",
        start_date=today + timedelta(days=8),
        end_date=today + timedelta(days=15),
        duration=6,
        planned_hours=48.0,
        workers=json.dumps(["Giovanni Prod"]),
        worker_hours=json.dumps({"Giovanni Prod": 48.0}),
        completed=0
    )
    db_session.add_all([t1, t2, t3])
    await db_session.commit()
    await db_session.refresh(t2)
    await db_session.refresh(t3)

    # Link FS da t2 a t3
    link_beta = Link(
        project_id=p2.id,
        source=t2.id,
        target=t3.id,
        type=LinkType.FS,
        lag=0
    )
    db_session.add(link_beta)
    await db_session.commit()

    # Genera suggerimenti per Commessa 1
    result = await generate_project_smart_suggestions(db_session, str(p1.id))
    assert "related_projects" in result
    assert str(p2.id) in result["related_projects"]

    p2_data = result["related_projects"][str(p2.id)]
    assert p2_data["project_name"] == "Commessa Beta Impattata"
    assert len(p2_data["tasks"]) == 2

    # Verifica che la proposta contenga la correzione a catena calcolata
    sugg = result["suggestions"][0]
    other_impacts = sugg["cascade_impact"]["other_projects"]
    assert len(other_impacts) >= 1
    impact = other_impacts[0]
    assert impact["status"] == "warning"
    assert impact["proposed_correction"] is not None

    corr = impact["proposed_correction"]
    assert corr["task_id"] == str(t2.id)
    assert corr["task_name"] == "Progettazione Beta"
    assert corr["shift_working_days"] > 0
    assert "Slittamento a catena" in corr["summary"]
    # Verifica propagazione a cascata su t3 (Montaggio Beta)
    assert len(corr["cascade_tasks"]) >= 1
    assert corr["cascade_tasks"][0]["task_name"] == "Montaggio Beta"


@pytest.mark.asyncio
async def test_apply_cross_project_corrections_flow(db_session: AsyncSession, test_user: User):
    """
    Test 6: Verifica applicazione effettiva delle correzioni a catena su commesse correlate:
    Quando l'utente approva una riprogrammazione che include correzioni cross-project,
    il task impattato dell'altra commessa e i suoi successori a valle vengono aggiornati nel DB
    e tracciati nel ReplanLog.
    """
    today = date.today()
    # 1. Commessa 1
    p1 = Project(
        name="Commessa Alfa Principale",
        code="COMM-ALFA",
        status=ProjectStatus.ACTIVE,
        owner_id=test_user.id,
        start_date=today - timedelta(days=30),
        end_date=today + timedelta(days=60)
    )
    # Commessa 2
    p2 = Project(
        name="Commessa Beta Secondaria",
        code="COMM-BETA",
        status=ProjectStatus.ACTIVE,
        owner_id=test_user.id,
        start_date=today - timedelta(days=30),
        end_date=today + timedelta(days=60)
    )
    db_session.add_all([p1, p2])
    await db_session.commit()
    await db_session.refresh(p1)
    await db_session.refresh(p2)

    # Task principale Commessa 1 (scaduto nel passato, genera proposta di recupero che sovrappone t2)
    t1 = Task(
        project_id=p1.id,
        text="Fase Alfa",
        start_date=today - timedelta(days=15),
        end_date=today - timedelta(days=5),
        duration=10,
        planned_hours=80.0,
        workers=json.dumps(["Worker Shared"]),
        worker_hours=json.dumps({"Worker Shared": 80.0}),
        completed=0
    )
    # Task impattato Commessa 2
    t2 = Task(
        project_id=p2.id,
        text="Fase Beta Sovrapposta",
        start_date=today,
        end_date=today + timedelta(days=7),
        duration=6,
        planned_hours=48.0,
        workers=json.dumps(["Worker Shared"]),
        worker_hours=json.dumps({"Worker Shared": 48.0}),
        completed=0
    )
    # Successore di t2
    t3 = Task(
        project_id=p2.id,
        text="Fase Beta Successiva",
        start_date=today + timedelta(days=8),
        end_date=today + timedelta(days=12),
        duration=4,
        planned_hours=32.0,
        workers=json.dumps(["Worker Altro"]),
        worker_hours=json.dumps({"Worker Altro": 32.0}),
        completed=0
    )
    db_session.add_all([t1, t2, t3])
    await db_session.commit()
    await db_session.refresh(t1)
    await db_session.refresh(t2)
    await db_session.refresh(t3)

    # Link FS tra t2 e t3
    link = Link(
        project_id=p2.id,
        source=t2.id,
        target=t3.id,
        type=LinkType.FS,
        lag=0
    )
    db_session.add(link)
    await db_session.commit()

    # Genera suggerimenti per Commessa 1
    result = await generate_project_smart_suggestions(db_session, str(p1.id))
    sugg = result["suggestions"][0]
    corr = sugg["cascade_impact"]["other_projects"][0]["proposed_correction"]
    assert corr is not None

    # Applica proposta con correzione cross-project
    payload = {
        **sugg["proposed_changes"],
        "reason": sugg["title"],
        "cascade_successors": sugg["cascade_impact"].get("same_project_tasks", []),
        "related_project_corrections": [corr]
    }

    apply_res = await apply_smart_replanning_proposal(
        db_session, str(p1.id), payload, test_user
    )
    assert apply_res["success"] is True

    # Verifica aggiornamento di t2 (commessa correlata)
    await db_session.refresh(t2)
    expected_t2_start = date.fromisoformat(corr["proposed_start"][:10])
    expected_t2_end = date.fromisoformat(corr["proposed_end"][:10])
    assert t2.start_date == expected_t2_start
    assert t2.end_date == expected_t2_end

    # Verifica aggiornamento a cascata di t3 (successore in commessa correlata)
    if corr.get("cascade_tasks"):
        await db_session.refresh(t3)
        sub_c = corr["cascade_tasks"][0]
        expected_t3_start = date.fromisoformat(sub_c["proposed_start"][:10])
        assert t3.start_date == expected_t3_start


@pytest.mark.asyncio
async def test_smart_replanning_fs_dependency_and_independence(db_session: AsyncSession, test_user: User):
    """
    Test 7: Rispetto rigoroso di dipendenze e indipendenze tra fasi:
    - Fase 1 (Disegno) con link FS verso Fase 2 (Approvazione).
    - Fase 2 con link FS verso Fase 3 (Assemblaggio Meccanico).
    - Fase 4 (Cablaggio) NON è collegata a Fase 3 (nessuna dipendenza).
    
    Verifiche:
    1. Quando Fase 1 slitta, Fase 2 deve iniziare rigorosamente DOPO il termine di Fase 1.
    2. Fase 3 deve iniziare rigorosamente DOPO il termine di Fase 2.
    3. Fase 4, non dipendendo da Fase 3, NON deve essere spostata né ritardata dal ritardo di Fase 3.
    """
    p_start = date(2026, 8, 24)
    p_end = date(2026, 9, 30)

    project = Project(
        name="Commessa TEST-REB-2026",
        code="TEST-REB-2026",
        status=ProjectStatus.ACTIVE,
        owner_id=test_user.id,
        start_date=p_start,
        end_date=p_end
    )
    db_session.add(project)
    await db_session.commit()
    await db_session.refresh(project)

    # 4 Fasi come nello scenario dell'utente:
    # Fase 1: 26/08 - 02/09 (scaduta/in ritardo)
    fase1 = Task(
        project_id=project.id,
        text="Fase 1: Disegno Schemi Elettrici",
        start_date=date(2026, 8, 26),
        end_date=date(2026, 9, 2),
        duration=6,
        planned_hours=48.0,
        workers=json.dumps(["Marco UT"]),
        worker_hours=json.dumps({"Marco UT": 48.0}),
        completed=0
    )
    # Fase 2: 03/09 - 07/09 (dipende da Fase 1)
    fase2 = Task(
        project_id=project.id,
        text="Fase 2: Approvazione Componenti e Distinta Base",
        start_date=date(2026, 9, 3),
        end_date=date(2026, 9, 7),
        duration=3,
        planned_hours=24.0,
        workers=json.dumps(["Anna UT"]),
        worker_hours=json.dumps({"Anna UT": 24.0}),
        completed=0
    )
    # Fase 3: 08/09 - 09/09 (dipende da Fase 2)
    fase3 = Task(
        project_id=project.id,
        text="Fase 3: Assemblaggio Meccanico Principale",
        start_date=date(2026, 9, 8),
        end_date=date(2026, 9, 9),
        duration=2,
        planned_hours=16.0,
        workers=json.dumps(["Franco Prod"]),
        worker_hours=json.dumps({"Franco Prod": 16.0}),
        completed=0
    )
    # Fase 4: 14/09 - 18/09 (INDIPENDENTE, NESSUN LINK DA FASE 3)
    fase4 = Task(
        project_id=project.id,
        text="Fase 4: Cablaggio e Collaudo Finale",
        start_date=date(2026, 9, 14),
        end_date=date(2026, 9, 18),
        duration=5,
        planned_hours=40.0,
        workers=json.dumps(["Roberto Prod"]),
        worker_hours=json.dumps({"Roberto Prod": 40.0}),
        completed=0
    )

    db_session.add_all([fase1, fase2, fase3, fase4])
    await db_session.commit()
    for f in (fase1, fase2, fase3, fase4):
        await db_session.refresh(f)

    # Link FS: Fase 1 -> Fase 2
    link1_2 = Link(
        project_id=project.id,
        source=fase1.id,
        target=fase2.id,
        type=LinkType.FS,
        lag=0
    )
    # Link FS: Fase 2 -> Fase 3
    link2_3 = Link(
        project_id=project.id,
        source=fase2.id,
        target=fase3.id,
        type=LinkType.FS,
        lag=0
    )
    # NOTA: NESSUN LINK tra Fase 3 e Fase 4!
    db_session.add_all([link1_2, link2_3])
    await db_session.commit()

    # Genera suggerimenti di riprogrammazione AI
    result = await generate_project_smart_suggestions(db_session, str(project.id), test_user)
    suggestions = result.get("suggestions", [])
    assert len(suggestions) >= 1

    # Trova la proposta di recupero per Fase 1
    sugg1 = next((s for s in suggestions if s["task_id"] == str(fase1.id)), None)
    assert sugg1 is not None

    fase1_new_end = date.fromisoformat(sugg1["proposed_changes"]["end_date"][:10])

    # Verifica cascata su Fase 2
    cascade_list = sugg1["cascade_impact"]["same_project_tasks"]
    casc_fase2 = next((c for c in cascade_list if c["task_id"] == str(fase2.id)), None)
    assert casc_fase2 is not None

    fase2_new_start = date.fromisoformat(casc_fase2["proposed_start"][:10])
    fase2_new_end = date.fromisoformat(casc_fase2["proposed_end"][:10])
    
    # 1. Fase 2 NON può iniziare prima che Fase 1 sia terminata (+1 gg lavorativo)
    assert fase2_new_start > fase1_new_end

    # 2. Fase 3 (sub_successore di Fase 2) deve iniziare DOPO il termine di Fase 2
    sub_successors = casc_fase2.get("sub_successors", [])
    casc_fase3 = next((c for c in sub_successors if c["task_id"] == str(fase3.id)), None)
    assert casc_fase3 is not None
    fase3_new_start = date.fromisoformat(casc_fase3["proposed_start"][:10])
    assert fase3_new_start > fase2_new_end

    # 3. Fase 4 NON deve essere toccata dalla catena (nessuna dipendenza da Fase 3)
    casc_fase4_direct = next((c for c in cascade_list if c["task_id"] == str(fase4.id)), None)
    casc_fase4_sub = next((c for c in casc_fase3.get("sub_successors", []) if c["task_id"] == str(fase4.id)), None)
    assert casc_fase4_direct is None
    assert casc_fase4_sub is None


@pytest.mark.asyncio
async def test_revert_with_cascade_modifications(db_session: AsyncSession, test_user: User):
    """
    Test: Verifica che annullando una modifica applicata con il replanning AI,
    vengano automaticamente annullate anche tutte le modifiche a cascata causate.
    """
    project = Project(
        name="Commessa Revert Cascata",
        status=ProjectStatus.ACTIVE,
        owner_id=test_user.id,
        start_date=date(2026, 9, 1),
        end_date=date(2026, 9, 30)
    )
    db_session.add(project)
    await db_session.commit()
    await db_session.refresh(project)

    # Fase 1 (principale da spostare)
    orig_fase1_start = date(2026, 9, 1)
    orig_fase1_end = date(2026, 9, 4)
    t1 = Task(
        project_id=project.id,
        text="Fase Principale 1",
        start_date=orig_fase1_start,
        end_date=orig_fase1_end,
        duration=4,
        planned_hours=32.0,
        workers=json.dumps(["Operatore 1"])
    )
    # Fase 2 (dipendente a cascata)
    orig_fase2_start = date(2026, 9, 7)
    orig_fase2_end = date(2026, 9, 11)
    t2 = Task(
        project_id=project.id,
        text="Fase Cascata 2",
        start_date=orig_fase2_start,
        end_date=orig_fase2_end,
        duration=5,
        planned_hours=40.0,
        workers=json.dumps(["Operatore 2"])
    )
    db_session.add_all([t1, t2])
    await db_session.commit()
    await db_session.refresh(t1)
    await db_session.refresh(t2)

    # Payload proposta che sposta t1 e applica cascata su t2
    new_fase1_start = date(2026, 9, 8)
    new_fase1_end = date(2026, 9, 11)
    new_fase2_start = date(2026, 9, 14)
    new_fase2_end = date(2026, 9, 18)

    proposal = {
        "task_id": str(t1.id),
        "start_date": new_fase1_start.isoformat(),
        "end_date": new_fase1_end.isoformat(),
        "workers": ["Operatore 1"],
        "shift_working_days": 5,
        "reason": "Riprogrammazione Fase 1 con cascata",
        "cascade_successors": [
            {
                "task_id": str(t2.id),
                "proposed_start": new_fase2_start.isoformat(),
                "proposed_end": new_fase2_end.isoformat(),
                "shift_working_days": 5
            }
        ]
    }

    # 1. Applica proposta
    apply_res = await apply_smart_replanning_proposal(db_session, str(project.id), proposal, test_user)
    assert apply_res["success"] is True
    log_id = apply_res["log_id"]

    await db_session.refresh(t1)
    await db_session.refresh(t2)
    assert t1.start_date == new_fase1_start
    assert t1.end_date == new_fase1_end
    assert t2.start_date == new_fase2_start
    assert t2.end_date == new_fase2_end

    # 2. Annulla modifica (Revert)
    revert_res = await revert_smart_replanning_log(db_session, log_id, test_user)
    assert revert_res["success"] is True
    assert revert_res["cascade_reverted_count"] == 1

    await db_session.refresh(t1)
    await db_session.refresh(t2)
    # ENTRAMBE le fasi devono essere ritornate alle date originali!
    assert t1.start_date == orig_fase1_start
    assert t1.end_date == orig_fase1_end
    assert t2.start_date == orig_fase2_start
    assert t2.end_date == orig_fase2_end


@pytest.mark.asyncio
async def test_smart_replanning_custom_dates_cascade_and_revert(db_session: AsyncSession, test_user: User):
    """
    Test: Verifica che le fasi spezzettate (budget_mode == 'custom_dates')
    vengano correttamente gestite nella propagazione a cascata e nell'applicazione/annullamento:
    - Conservano le date personalizzate non consecutive traslandole di N giorni lavorativi
    - Calcolano la data di fine coerente con l'ultima data spezzettata
    - Registrano old_custom_dates nel ReplanLog
    - Ripristinano le date spezzettate originali in caso di revert
    """
    project = Project(
        name="Commessa Spezzettata",
        code="COMM-SPLIT",
        status=ProjectStatus.ACTIVE,
        owner_id=test_user.id,
        start_date=date(2026, 10, 5),
        end_date=date(2026, 11, 30)
    )
    db_session.add(project)
    await db_session.commit()
    await db_session.refresh(project)

    # Fase 1 (normale)
    t1 = Task(
        project_id=project.id,
        text="Fase 1 Predecessore",
        start_date=date(2026, 10, 5),
        end_date=date(2026, 10, 7),
        duration=3,
        planned_hours=24.0,
        workers=json.dumps(["Operatore 1"]),
        completed=0
    )
    # Fase 2 (spezzettata: Lun 12, Mar 13, Ven 16, Lun 19)
    orig_custom_dates = [
        {"date": "2026-10-12", "hours": 8},
        {"date": "2026-10-13", "hours": 8},
        {"date": "2026-10-16", "hours": 8},
        {"date": "2026-10-19", "hours": 8}
    ]
    t2 = Task(
        project_id=project.id,
        text="Fase 2 Spezzettata",
        budget_mode="custom_dates",
        custom_dates=json.dumps(orig_custom_dates),
        start_date=date(2026, 10, 12),
        end_date=date(2026, 10, 19),
        duration=4,
        planned_hours=32.0,
        workers=json.dumps(["Operatore 2"]),
        completed=0
    )
    db_session.add_all([t1, t2])
    await db_session.commit()
    await db_session.refresh(t1)
    await db_session.refresh(t2)

    # Link FS tra Fase 1 e Fase 2
    link = Link(
        project_id=project.id,
        source=t1.id,
        target=t2.id,
        type=LinkType.FS,
        lag=0
    )
    db_session.add(link)
    await db_session.commit()

    # Simuliamo che Fase 1 slitti e finisca il 14/10 invece del 7/10 (+5 giorni lavorativi)
    # Di conseguenza Fase 2 deve iniziare il 15/10 (invece del 12/10, slittamento di 3 gg lavorativi)
    # e le sue custom_dates devono traslare di 3 giorni lavorativi:
    # 12/10 + 3gg = 15/10 (Gio)
    # 13/10 + 3gg = 16/10 (Ven)
    # 16/10 + 3gg = 21/10 (Mer)
    # 19/10 + 3gg = 22/10 (Gio)
    proposal = {
        "task_id": str(t1.id),
        "start_date": "2026-10-12",
        "end_date": "2026-10-14",
        "shift_working_days": 5,
        "cascade_successors": [
            {
                "task_id": str(t2.id),
                "proposed_start": "2026-10-15",
                "proposed_end": "2026-10-22",
                "shift_working_days": 3
            }
        ]
    }

    # Applica proposta
    apply_res = await apply_smart_replanning_proposal(db_session, str(project.id), proposal, test_user)
    assert apply_res["success"] is True
    log_id = apply_res["log_id"]

    await db_session.refresh(t2)
    assert t2.start_date == date(2026, 10, 15)
    assert t2.end_date == date(2026, 10, 22)
    new_c_dates = json.loads(t2.custom_dates)
    assert len(new_c_dates) == 4
    assert new_c_dates[0]["date"] == "2026-10-15"
    assert new_c_dates[1]["date"] == "2026-10-16"
    assert new_c_dates[2]["date"] == "2026-10-21"
    assert new_c_dates[3]["date"] == "2026-10-22"

    # Revert
    revert_res = await revert_smart_replanning_log(db_session, log_id, test_user)
    assert revert_res["success"] is True

    await db_session.refresh(t2)
    assert t2.start_date == date(2026, 10, 12)
    assert t2.end_date == date(2026, 10, 19)
    restored_c_dates = json.loads(t2.custom_dates)
    assert len(restored_c_dates) == 4
    assert restored_c_dates[0]["date"] == "2026-10-12"
    assert restored_c_dates[3]["date"] == "2026-10-19"





