import json
from datetime import datetime, timedelta
from typing import List, Dict, Any
# pyrefly: ignore [missing-import]
from fastapi import APIRouter, Depends
# pyrefly: ignore [missing-import]
from sqlalchemy.ext.asyncio import AsyncSession
# pyrefly: ignore [missing-import]
from sqlalchemy.future import select
from app.core.dependencies import get_db, get_current_user
from app.models.user import User
from app.models.task import Task
from app.models.vacation import Vacation

router = APIRouter(prefix="/api/workload", tags=["workload"])

@router.get("/heatmap")
async def get_workload_heatmap(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
) -> Dict[str, Any]:
    # pyrefly: ignore [missing-import]
    from sqlalchemy.orm import joinedload
    users_res = await db.execute(select(User))
    users = users_res.scalars().all()
    
    tasks_res = await db.execute(select(Task).options(joinedload(Task.project)))
    tasks = tasks_res.scalars().all()
    
    # Fetch all vacations
    vac_res = await db.execute(select(Vacation))
    vacations = vac_res.scalars().all()
    
    # Build vacation lookup: user_id -> list of vacation date ranges
    vac_by_user = {}
    for v in vacations:
        uid = str(v.user_id)
        if uid not in vac_by_user:
            vac_by_user[uid] = []
        vac_by_user[uid].append({
            "start_date": str(v.start_date),
            "end_date": str(v.end_date),
            "reason": v.reason or ""
        })
    
    heatmap = {}
    for u in users:
        uid = str(u.id)
        heatmap[uid] = {
            "full_name": u.full_name or u.username,
            "username": u.username,
            "department": u.department,
            "workload": {},
            "actual_workload": {},
            "vacations": vac_by_user.get(uid, [])
        }
        
    for task in tasks:
        if not task.start_date or not task.end_date:
            continue
            
        assigned_workers = []
        try:
            workers_list = json.loads(task.workers) if task.workers else []
            for w in workers_list:
                assigned_workers.append(w)
        except:
            pass
            
        if not assigned_workers:
            continue
            
        worker_info = []
        for w_name in assigned_workers:
            for u in users:
                if (u.full_name and w_name.lower() in u.full_name.lower()) or (u.username and w_name.lower() in u.username.lower()):
                    worker_info.append({"id": str(u.id), "name": w_name})
                    break
                    
        if not worker_info:
            continue
            
        start_date = task.start_date
        end_date = task.end_date
        
        excluded_dates = []
        try:
            ex_dates_raw = getattr(task, 'excluded_dates', '[]')
            if isinstance(ex_dates_raw, str):
                excluded_dates = json.loads(ex_dates_raw or '[]')
            elif isinstance(ex_dates_raw, list):
                excluded_dates = ex_dates_raw
        except:
            excluded_dates = []
            
        delta = end_date - start_date
        days = []
        for i in range(delta.days + 1):
            day = start_date + timedelta(days=i)
            # Skip weekends and explicitly excluded dates
            if day.weekday() < 5 and day.strftime("%Y-%m-%d") not in excluded_dates:
                days.append(day)
                
        task_type_str = task.type.value if hasattr(task.type, 'value') else str(task.type)
        if task_type_str.lower() == "milestone" or task_type_str == "TaskType.MILESTONE":
            task_type_str = "milestone"

        budget_mode = getattr(task, 'budget_mode', 'start_days')
        raw_c_dates = getattr(task, 'custom_dates', None)
        parsed_custom_dates: List[Dict[str, Any]] = []
        if budget_mode == 'custom_dates' and raw_c_dates:
            try:
                c_list = json.loads(raw_c_dates) if isinstance(raw_c_dates, str) else raw_c_dates
                if isinstance(c_list, list):
                    for item in c_list:
                        if isinstance(item, str):
                            parsed_custom_dates.append({"date": item, "hours": 8.0})
                        elif isinstance(item, dict) and item.get("date"):
                            try:
                                h = float(item.get("hours", 8.0))
                            except (ValueError, TypeError):
                                h = 8.0
                            parsed_custom_dates.append({"date": str(item["date"]), "hours": h})
            except Exception:
                parsed_custom_dates = []

        worker_hours_map = {}
        try:
            worker_hours_map = json.loads(getattr(task, 'worker_hours', '{}')) or {}
        except:
            worker_hours_map = {}

        planned_hours = task.planned_hours or 0.0

        if budget_mode == 'custom_dates' and parsed_custom_dates:
            total_custom_h = sum(float(d.get("hours", 0.0)) for d in parsed_custom_dates)
            for winfo in worker_info:
                w_id = winfo["id"]
                w_name = winfo["name"]

                if w_name in worker_hours_map and worker_hours_map[w_name] is not None:
                    try:
                        assigned_total = float(worker_hours_map[w_name])
                    except:
                        assigned_total = planned_hours / len(worker_info)
                else:
                    assigned_total = planned_hours / len(worker_info)

                if len(worker_info) == 1:
                    worker_ratio = 1.0
                elif total_custom_h > 0:
                    worker_ratio = assigned_total / total_custom_h
                else:
                    worker_ratio = 1.0 / len(worker_info)

                for cd in parsed_custom_dates:
                    date_str = str(cd["date"])
                    if date_str not in heatmap[w_id]["workload"]:
                        heatmap[w_id]["workload"][date_str] = {"hours": 0.0, "tasks": []}

                    cd_hours = float(cd.get("hours", 0.0))
                    daily_hours = 0.0 if task_type_str == "milestone" else (cd_hours * worker_ratio)

                    heatmap[w_id]["workload"][date_str]["hours"] += daily_hours
                    heatmap[w_id]["workload"][date_str]["tasks"].append({
                        "id": str(task.id),
                        "name": task.text,
                        "project_name": task.project.name if task.project else "Progetto non specificato",
                        "project_id": str(task.project.id) if task.project else None,
                        "project_code": getattr(task.project, "code", None) if task.project else None,
                        "project_status": getattr(task.project, "status", None) if task.project else None,
                        "start_date": task.start_date.strftime("%Y-%m-%d"),
                        "end_date": task.end_date.strftime("%Y-%m-%d"),
                        "hours": daily_hours,
                        "total_assigned_hours": 0.0 if task_type_str == "milestone" else assigned_total,
                        "color": getattr(task, "color", None) or "#3b82f6",
                        "type": task_type_str,
                        "budget_mode": budget_mode,
                        "custom_dates": parsed_custom_dates
                    })
        else:
            delta = end_date - start_date
            days = []
            for i in range(delta.days + 1):
                day = start_date + timedelta(days=i)
                # Skip weekends and explicitly excluded dates
                if day.weekday() < 5 and day.strftime("%Y-%m-%d") not in excluded_dates:
                    days.append(day)

            if days:
                for winfo in worker_info:
                    w_id = winfo["id"]
                    w_name = winfo["name"]

                    if w_name in worker_hours_map and worker_hours_map[w_name] is not None:
                        try:
                            assigned_total = float(worker_hours_map[w_name])
                        except:
                            assigned_total = planned_hours / len(worker_info)
                    else:
                        assigned_total = planned_hours / len(worker_info)

                    hours_per_day = assigned_total / len(days)

                    for day in days:
                        date_str = day.strftime("%Y-%m-%d")
                        if date_str not in heatmap[w_id]["workload"]:
                            heatmap[w_id]["workload"][date_str] = {"hours": 0.0, "tasks": []}

                        daily_hours = 0.0 if task_type_str == "milestone" else hours_per_day

                        heatmap[w_id]["workload"][date_str]["hours"] += daily_hours
                        heatmap[w_id]["workload"][date_str]["tasks"].append({
                            "id": str(task.id),
                            "name": task.text,
                            "project_name": task.project.name if task.project else "Progetto non specificato",
                            "project_id": str(task.project.id) if task.project else None,
                            "project_code": getattr(task.project, "code", None) if task.project else None,
                            "project_status": getattr(task.project, "status", None) if task.project else None,
                            "start_date": task.start_date.strftime("%Y-%m-%d"),
                            "end_date": task.end_date.strftime("%Y-%m-%d"),
                            "hours": daily_hours,
                            "total_assigned_hours": 0.0 if task_type_str == "milestone" else assigned_total,
                            "color": getattr(task, "color", None) or "#3b82f6",
                            "type": task_type_str,
                            "budget_mode": budget_mode,
                            "custom_dates": []
                        })

        # Process actual hours
        actual_hours_map = {}
        try:
            actual_hours_map = json.loads(getattr(task, 'actual_hours', '{}')) or {}
        except:
            pass
            
        for w_username, date_hrs in actual_hours_map.items():
            if not isinstance(date_hrs, dict):
                continue
                
            w_id = None
            for u in users:
                if (u.username and u.username.lower() == w_username.lower()) or (u.full_name and w_username.lower() in u.full_name.lower()):
                    w_id = str(u.id)
                    break
                    
            if w_id:
                # Calculate total actual for this user on this task
                total_actual = 0.0
                for v in date_hrs.values():
                    try:
                        total_actual += float(v)
                    except:
                        pass
                        
                for date_str, hrs in date_hrs.items():
                    try:
                        h_val = float(hrs)
                    except:
                        continue
                        
                    if h_val > 0:
                        if date_str not in heatmap[w_id]["actual_workload"]:
                            heatmap[w_id]["actual_workload"][date_str] = {"hours": 0.0, "tasks": []}
                            
                        heatmap[w_id]["actual_workload"][date_str]["hours"] += h_val
                        heatmap[w_id]["actual_workload"][date_str]["tasks"].append({
                            "id": str(task.id),
                            "name": task.text,
                            "project_name": task.project.name if task.project else "Progetto non specificato",
                            "project_id": str(task.project.id) if task.project else None,
                            "project_code": getattr(task.project, "code", None) if task.project else None,
                            "project_status": getattr(task.project, "status", None) if task.project else None,
                            "start_date": task.start_date.strftime("%Y-%m-%d") if task.start_date else None,
                            "end_date": task.end_date.strftime("%Y-%m-%d") if task.end_date else None,
                            "hours": h_val,
                            "total_assigned_hours": total_actual,
                            "color": getattr(task, "color", None) or "#3b82f6",
                            "type": task_type_str,
                            "budget_mode": budget_mode,
                            "custom_dates": parsed_custom_dates
                        })
                
    return {"heatmap": heatmap}

@router.get("/export/excel")
async def export_workload_excel_route(
    mode: str = "both",
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    # pyrefly: ignore [missing-import]
    from fastapi.responses import StreamingResponse
    from app.services import export_service
    data = await get_workload_heatmap(db, current_user)
    buffer = await export_service.export_workload_excel(data["heatmap"], mode)
    return StreamingResponse(
        buffer,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=Saturazione_Carichi_Lavoro.xlsx"}
    )

@router.get("/export/pdf")
async def export_workload_pdf_route(
    mode: str = "both",
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    # pyrefly: ignore [missing-import]
    from fastapi.responses import StreamingResponse
    from app.services import export_service
    data = await get_workload_heatmap(db, current_user)
    buffer = await export_service.export_workload_pdf(data["heatmap"], mode)
    return StreamingResponse(
        buffer,
        media_type="application/pdf",
        headers={"Content-Disposition": "attachment; filename=Saturazione_Carichi_Lavoro.pdf"}
    )
