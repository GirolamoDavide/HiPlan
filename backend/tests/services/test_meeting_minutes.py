import pytest
from app.services.chat_service import chat_service

@pytest.mark.asyncio
async def test_generate_meeting_minutes_fallback_and_structure():
    transcript = """
    Buongiorno a tutti. Oggi facciamo il punto sulla Commessa Salads.
    Mario si occuperà del montaggio quadri entro venerdì 25 settembre.
    Luca contatterà il fornitore per i sensori di temperatura.
    Abbiamo deciso di posticipare il collaudo finale a lunedì prossimo per attendere la consegna.
    """
    
    result = await chat_service.generate_meeting_minutes(
        transcript=transcript,
        meeting_type="operativa",
        title="Allineamento Commessa Salads"
    )
    
    assert isinstance(result, dict)
    assert "title" in result
    assert "summary_html" in result
    assert "key_points" in result
    assert "decisions" in result
    assert "action_items" in result
    assert "Salads" in result["title"]
    assert "<h1>" in result["summary_html"]
    assert "<h2>" in result["summary_html"]
    assert "<details" not in result["summary_html"].lower()
    assert "trascrizione integrale" not in result["summary_html"].lower()

@pytest.mark.asyncio
async def test_generate_meeting_minutes_empty_raises():
    with pytest.raises(ValueError):
        await chat_service.generate_meeting_minutes(transcript="")
