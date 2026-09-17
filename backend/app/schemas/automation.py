# pyrefly: ignore [missing-import]
from pydantic import BaseModel
from typing import Optional, List, Any, Dict
from datetime import datetime


class AutomationRuleCreate(BaseModel):
    name: str
    description: Optional[str] = None
    trigger_type: str  # phase_completed | budget_hours_exceeded | phase_deadline_approaching
    trigger_config: Optional[Dict[str, Any]] = {}
    conditions: Optional[Dict[str, Any]] = {}
    action_type: str  # create_todo | send_notification
    action_config: Optional[Dict[str, Any]] = {}
    is_active: bool = True


class AutomationRuleUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    trigger_type: Optional[str] = None
    trigger_config: Optional[Dict[str, Any]] = None
    conditions: Optional[Dict[str, Any]] = None
    action_type: Optional[str] = None
    action_config: Optional[Dict[str, Any]] = None
    is_active: Optional[bool] = None


class AutomationRuleOut(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    trigger_type: str
    trigger_config: Dict[str, Any]
    conditions: Dict[str, Any]
    action_type: str
    action_config: Dict[str, Any]
    is_active: bool
    trigger_count: int
    last_triggered_at: Optional[datetime] = None
    creator_id: Optional[str] = None
    creator_name: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class AutomationLogOut(BaseModel):
    id: str
    rule_id: Optional[str] = None
    rule_name: str
    trigger_type: str
    action_type: str
    project_id: Optional[str] = None
    project_code: Optional[str] = None
    project_name: Optional[str] = None
    task_id: Optional[str] = None
    task_name: Optional[str] = None
    details: Optional[str] = None
    status: str
    error_message: Optional[str] = None
    created_at: Optional[datetime] = None
