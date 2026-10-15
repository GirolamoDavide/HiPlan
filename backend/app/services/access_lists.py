"""Elenchi di accesso gestiti dagli admin (chi può vedere / chi può compilare una sezione),
salvati come liste di username nella tabella settings."""
import json
from typing import List

# pyrefly: ignore [missing-import]
from sqlalchemy import select
# pyrefly: ignore [missing-import]
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.setting import Setting
from app.models.user import User, UserRole


async def get_list_setting(db: AsyncSession, key: str) -> List[str]:
    res = await db.execute(select(Setting).where(Setting.key == key))
    setting = res.scalar_one_or_none()
    try:
        value = json.loads(setting.value) if setting and setting.value else []
        return value if isinstance(value, list) else []
    except Exception:
        return []


async def set_list_setting(db: AsyncSession, key: str, values: List[str]) -> None:
    res = await db.execute(select(Setting).where(Setting.key == key))
    setting = res.scalar_one_or_none()
    if setting:
        setting.value = json.dumps(values)
    else:
        db.add(Setting(key=key, value=json.dumps(values)))


async def get_section_access(db: AsyncSession, user: User, viewers_key: str, editors_key: str) -> dict:
    """Gli admin vedono e compilano sempre; chi può compilare può anche vedere."""
    if user.role == UserRole.ADMIN:
        return {"can_view": True, "can_edit": True}
    editors = await get_list_setting(db, editors_key)
    viewers = await get_list_setting(db, viewers_key)
    can_edit = user.username in editors
    return {"can_view": can_edit or user.username in viewers, "can_edit": can_edit}
