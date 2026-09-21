import pytest
from datetime import date, timedelta
from app.models.project import Project, ProjectStatus
from app.models.task import Task, TaskType
from app.models.user import User, UserRole
from app.services.chat_service import chat_service, normalize_progress
from app.services.project_ai_service import analyze_project_ai
from sqlalchemy.ext.asyncio import AsyncSession


@pytest.mark.asyncio
async def test_normalize_progress():
    assert normalize_progress(None) == 0
    assert normalize_progress(0) == 0
    assert normalize_progress(0.7) == 70
    assert normalize_progress(0.97) == 97
    assert normalize_progress(1.0) == 100
    assert normalize_progress(80) == 80
    assert normalize_progress("invalid") == 0


@pytest.mark.asyncio
async def test_admin_report_kpis_and_tipologia(db_session: AsyncSession):
    # 0. Create user
    user = User(
        email="owner@example.com",
        username="owner_user",
        hashed_password="pw",
        full_name="Owner Admin",
        role=UserRole.ADMIN,
        is_active=True
    )
    db_session.add(user)
    await db_session.flush()

    # 1. Create projects with distinct tipologie
    p_std = Project(
        name="Commessa Standard",
        code="STD-01",
        status=ProjectStatus.ACTIVE,
        owner_id=user.id,
        is_atex=False,
        is_alimentare=False,
        start_date=date.today(),
        end_date=date.today() + timedelta(days=30)
    )
    p_atex = Project(
        name="Commessa ATEX",
        code="ATX-01",
        status=ProjectStatus.ACTIVE,
        owner_id=user.id,
        is_atex=True,
        is_alimentare=False,
        start_date=date.today(),
        end_date=date.today() + timedelta(days=45)
    )
    p_both = Project(
        name="Commessa Ibrida",
        code="HYB-01",
        status=ProjectStatus.PLANNING,
        owner_id=user.id,
        is_atex=True,
        is_alimentare=True,
        start_date=date.today(),
        end_date=date.today() + timedelta(days=60)
    )
    db_session.add_all([p_std, p_atex, p_both])
    await db_session.flush()

    # 2. Add operative tasks with partial and complete progress
    t1 = Task(
        project_id=p_std.id,
        text="Fase Standard 1",
        start_date=date.today(),
        end_date=date.today() + timedelta(days=10),
        duration=10,
        progress=0.7,
        completed=0,
        type=TaskType.TASK
    )
    t2 = Task(
        project_id=p_atex.id,
        text="Fase ATEX 1",
        start_date=date.today(),
        end_date=date.today() + timedelta(days=15),
        duration=15,
        progress=1.0,
        completed=1,
        type=TaskType.TASK
    )
    # Milestone task (should be excluded from operative progress)
    t_m = Task(
        project_id=p_atex.id,
        text="Milestone Collaudo",
        start_date=date.today() + timedelta(days=15),
        end_date=date.today() + timedelta(days=15),
        duration=0,
        progress=0.0,
        completed=0,
        type=TaskType.MILESTONE
    )
    db_session.add_all([t1, t2, t_m])
    await db_session.commit()

    # 3. Generate admin report
    res = await chat_service.generate_admin_report(db_session)
    kpis = res["kpis"]

    assert kpis["total_projects"] >= 3
    assert kpis["atex_projects"] >= 2
    assert kpis["alimentare_projects"] >= 1
    assert kpis["standard_projects"] >= 1
    assert "report" in res
    assert len(res["report"]) > 0

    # Ensure no generic platitudes in the generated report
    report_lower = res["report"].lower()
    assert "monitorare attentamente" not in report_lower
    assert "verificare periodicamente" not in report_lower


@pytest.mark.asyncio
async def test_project_ai_analysis_progress_and_tipologia(db_session: AsyncSession):
    # Create test user
    user = User(
        email="lead@example.com",
        username="lead_user",
        hashed_password="pw",
        full_name="Lead Engineer",
        role=UserRole.ADMIN,
        is_active=True
    )
    db_session.add(user)
    await db_session.flush()

    # Create ATEX project
    p = Project(
        name="Impianto Chimico ATEX",
        code="CHM-99",
        status=ProjectStatus.ACTIVE,
        owner_id=user.id,
        is_atex=True,
        is_alimentare=False,
        start_date=date.today(),
        end_date=date.today() + timedelta(days=90),
        responsible_id=user.id
    )
    db_session.add(p)
    await db_session.flush()

    # Add tasks: 1 completed, 1 in progress at 50% -> average progress = 75%
    t1 = Task(
        project_id=p.id,
        text="Progettazione Quadro",
        start_date=date.today(),
        end_date=date.today() + timedelta(days=10),
        duration=10,
        progress=1.0,
        completed=1,
        type=TaskType.TASK
    )
    t2 = Task(
        project_id=p.id,
        text="Cablaggio e Certificazione ATEX",
        start_date=date.today() + timedelta(days=11),
        end_date=date.today() + timedelta(days=30),
        duration=20,
        progress=0.5,
        completed=0,
        type=TaskType.TASK
    )
    db_session.add_all([t1, t2])
    await db_session.commit()

    analysis_res = await analyze_project_ai(db_session, str(p.id), user)
    assert analysis_res["success"] is True
    assert analysis_res["is_atex"] is True
    assert analysis_res["is_alimentare"] is False
    assert analysis_res["tipologia"] == "ATEX"
    assert "analysis" in analysis_res
    assert len(analysis_res["analysis"]) > 0


@pytest.mark.asyncio
async def test_chat_preventivazione_exclusion_intent():
    """Verifica che tutte le domande su preventivi e richieste commerciali siano intercettate come preventivazione_restricted."""
    queries = [
        "Mostrami i preventivi aperti",
        "Ci sono richieste commerciali da gestire?",
        "Qual è lo stato della preventivazione?",
        "Quali sono i prezzi fornitore degli articoli di preventivo?",
        "Mostrami gli articoli richiesta del cliente Rossi",
        "Elenco offerte commerciali di questa settimana",
        "Costi fornitore per la richiesta commerciale",
        "Che margine preventivo abbiamo su questo pezzo?",
        "Visualizza i prezzi d'acquisto concordati coi fornitori"
    ]
    for q in queries:
        intent = chat_service._classify_intent(q)
        assert intent == "preventivazione_restricted", f"Query '{q}' doveva essere classificata come 'preventivazione_restricted', ma è '{intent}'"


@pytest.mark.asyncio
async def test_chat_preventivazione_response_block():
    """Verifica che il chatbot risponda con messaggio di accesso riservato e rimandi alla pagina Preventivazione."""
    test_user = User(
        email="test_user@example.com",
        username="mario_pm",
        full_name="Mario PM",
        role=UserRole.EDITOR,
        is_active=True
    )
    res = await chat_service.get_response("Puoi riepilogarmi i preventivi dei clienti?", current_user=test_user)
    assert "🔒" in res or "Riservat" in res
    assert "Preventivazione" in res
    assert "Coordinamento ➔ Preventivazione" in res


@pytest.mark.asyncio
async def test_chat_database_excludes_richieste_tables():
    """Verifica che le tabelle richieste_commerciali e articoli_richiesta non siano esposte al SQLDatabase del chatbot."""
    usable_tables = chat_service.db.get_usable_table_names()
    assert "richieste_commerciali" not in usable_tables
    assert "articoli_richiesta" not in usable_tables
    assert "activity_logs" not in usable_tables
    assert "notes" not in usable_tables


@pytest.mark.asyncio
async def test_chat_intents_routing_standard():
    """Verifica che gli altri intent standard del chatbot continuino a funzionare regolarmente."""
    assert chat_service._classify_intent("Ciao buongiorno!") == "chat"
    assert chat_service._classify_intent("Chi sei e cosa sai fare?") == "chat"
    assert chat_service._classify_intent("Dammi il briefing di oggi") == "briefing"
    assert chat_service._classify_intent("Quali sono le mie attività?") == "my_tasks"
    assert chat_service._classify_intent("Verifica il budget e ore consuntivate") == "budget"
    assert chat_service._classify_intent("Cosa succede se slitta la consegna?") == "what_if"
    assert chat_service._classify_intent("Mostrami la panoramica commesse") == "projects_overview"
    assert chat_service._classify_intent("Chi ha il maggior carico addetti?") == "team_workload"
    assert chat_service._classify_intent("Quali fasi sono in scadenza questo mese?") == "deadlines"
    assert chat_service._classify_intent("Rileva conflitti e ritardi nelle commesse") == "alarms"
    assert chat_service._classify_intent("Mostrami le mie note") == "notes_restricted"
    assert chat_service._classify_intent("Cosa ho annotato nei miei appunti?") == "notes_restricted"


@pytest.mark.asyncio
async def test_admin_report_with_todos_tickets_preventivazione(db_session: AsyncSession):
    """Verifica che il report AI esecutivo dell'Admin includa la panoramica su TODO, Ticket e Preventivazione."""
    from datetime import datetime
    from app.models.todo import Todo
    from app.models.ticket import Ticket, TicketStatus, TicketPriority
    from app.models.richiesta_commerciale import RichiestaCommerciale, RichiestaStatus, ArticoloRichiesta

    # Utente creatore
    user = User(
        email="test_multidomain@example.com",
        username="multidomain_user",
        hashed_password="pw",
        full_name="Multi Domain User",
        role=UserRole.ADMIN,
        is_active=True
    )
    db_session.add(user)
    await db_session.flush()

    # Inserisci un TODO pendente
    todo = Todo(
        title="Verifica conformità collaudo finale",
        creator_id=user.id,
        due_date=datetime.now() + timedelta(days=2),
        is_completed=False
    )
    db_session.add(todo)

    # Inserisci un Ticket ad alta priorità
    ticket = Ticket(
        title="Anomalia sensore di pressione linea 3",
        description="Il sensore segnala allarme fuorigiri",
        author_id=user.id,
        status=TicketStatus.DA_GESTIRE,
        priority=TicketPriority.HIGH
    )
    db_session.add(ticket)

    # Inserisci una Richiesta Commerciale con articolo
    richiesta = RichiestaCommerciale(
        title="Fornitura Skid Idrogeno 2026",
        cliente="Eni S.p.A.",
        numero_offerta="OFF-2026-99",
        author_id=user.id,
        status=RichiestaStatus.IN_LAVORAZIONE
    )
    db_session.add(richiesta)
    await db_session.flush()

    articolo = ArticoloRichiesta(
        richiesta_id=richiesta.id,
        titolo="Modulo Elettrolizzatore 500kW",
        costo=85000.0,
        prezzo_listino=115000.0,
        is_atex=True
    )
    db_session.add(articolo)
    await db_session.commit()

    # Genera il report
    res = await chat_service.generate_admin_report(db_session)
    kpis = res["kpis"]
    report = res["report"]

    # Verifica KPI TODO
    assert kpis["total_todos"] >= 1
    assert kpis["pending_todos"] >= 1
    assert "completed_todos" in kpis

    # Verifica KPI Ticket
    assert kpis["total_tickets"] >= 1
    assert kpis["open_tickets"] >= 1
    assert kpis["high_priority_tickets"] >= 1

    # Verifica KPI Preventivazione
    assert kpis["total_preventivi"] >= 1
    assert kpis["active_preventivi"] >= 1
    assert kpis["preventivi_estimated_value"] >= 115000.0

    # Verifica sezioni nel report Markdown
    assert "Panoramica Operativa: TODO & Checklist Interne" in report
    assert "Assistenza & Ticket di Supporto" in report
    assert "Pipeline Preventivazione & Richieste Commerciali" in report
    assert "Raccomandazioni Strategiche & Operative Interfunzionali" in report
    assert "Verifica conformità collaudo finale" in report
    assert "Anomalia sensore di pressione linea 3" in report
    assert "Eni S.p.A." in report

