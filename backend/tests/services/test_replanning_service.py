# pyrefly: ignore [missing-import]
import pytest
# pyrefly: ignore [missing-import]
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.user import User
from app.services.replanning_service import get_replanning_suggestions, get_zero_hours_alerts

@pytest.mark.asyncio
async def test_replan_project_suggestions(db_session: AsyncSession, test_user: User):
    try:
        suggestions = await get_replanning_suggestions(db_session, test_user)
        assert isinstance(suggestions, list)
        # Verifica che mancata consuntivazione (zero_hours) non sia più presente nei conflitti
        assert not any(s.get("type") == "zero_hours" for s in suggestions)
    except Exception as e:
        pytest.fail(f"Replanning service failed: {str(e)}")

@pytest.mark.asyncio
async def test_zero_hours_alerts(db_session: AsyncSession, test_user: User):
    try:
        alerts = await get_zero_hours_alerts(db_session, test_user)
        assert isinstance(alerts, list)
    except Exception as e:
        pytest.fail(f"Zero hours service failed: {str(e)}")
