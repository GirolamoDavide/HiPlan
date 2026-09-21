import pytest
from unittest.mock import MagicMock, patch
from app.services.chat_service import chat_service
from app.core.config import settings

@pytest.mark.asyncio
async def test_transcribe_audio_empty_bytes():
    with pytest.raises(ValueError, match="vuoto"):
        await chat_service.transcribe_audio(file_bytes=b"")

@pytest.mark.asyncio
async def test_transcribe_audio_success():
    fake_transcription = MagicMock()
    fake_transcription.text = "Buongiorno a tutti, iniziamo la riunione tecnica su Teams."
    fake_transcription.duration = 4.2

    mock_client = MagicMock()
    mock_client.audio.transcriptions.create.return_value = fake_transcription

    with patch("groq.Groq", return_value=mock_client), patch.object(settings, "GROQ_API_KEY", "fake_key"):
        result = await chat_service.transcribe_audio(
            file_bytes=b"FAKE_AUDIO_DATA",
            filename="meeting_call.webm",
            content_type="audio/webm",
            language="it"
        )

        assert isinstance(result, dict)
        assert "transcript" in result
        assert "Teams" in result["transcript"]
        assert result["duration"] == 4.2
        mock_client.audio.transcriptions.create.assert_called_once()
