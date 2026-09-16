import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  Sun,
  Cloud,
  CloudSun,
  CloudRain,
  CloudDrizzle,
  CloudSnow,
  CloudLightning,
  CloudFog,
  Wind,
  Droplets,
  Thermometer,
  MapPin,
  Search,
  X,
  RefreshCw,
  Calendar,
  Compass,
  Check,
  Clock,
  ChevronLeft,
  ChevronRight
} from 'lucide-react';
import './WeatherDateWidget.css';

// Mappatura WMO Weather Code di Open-Meteo in italiano, icone e stili
const WMO_CODES = {
  0: { label: 'Sereno', icon: Sun, type: 'clear', isSunny: true },
  1: { label: 'Prevalentemente sereno', icon: CloudSun, type: 'partly-cloudy' },
  2: { label: 'Parzialmente nuvoloso', icon: CloudSun, type: 'partly-cloudy' },
  3: { label: 'Coperto', icon: Cloud, type: 'cloudy' },
  45: { label: 'Nebbia', icon: CloudFog, type: 'fog' },
  48: { label: 'Nebbia con brina', icon: CloudFog, type: 'fog' },
  51: { label: 'Pioviggine leggera', icon: CloudDrizzle, type: 'drizzle' },
  53: { label: 'Pioviggine moderata', icon: CloudDrizzle, type: 'drizzle' },
  55: { label: 'Pioviggine fitta', icon: CloudDrizzle, type: 'drizzle' },
  56: { label: 'Pioviggine gelata', icon: CloudDrizzle, type: 'drizzle' },
  57: { label: 'Pioviggine gelata intensa', icon: CloudDrizzle, type: 'drizzle' },
  61: { label: 'Pioggia debole', icon: CloudRain, type: 'rain' },
  63: { label: 'Pioggia moderata', icon: CloudRain, type: 'rain' },
  65: { label: 'Pioggia forte', icon: CloudRain, type: 'rain' },
  66: { label: 'Pioggia gelicidio', icon: CloudRain, type: 'rain' },
  67: { label: 'Pioggia gelicidio forte', icon: CloudRain, type: 'rain' },
  71: { label: 'Neve debole', icon: CloudSnow, type: 'snow' },
  73: { label: 'Neve moderata', icon: CloudSnow, type: 'snow' },
  75: { label: 'Neve forte', icon: CloudSnow, type: 'snow' },
  77: { label: 'Granuli di neve', icon: CloudSnow, type: 'snow' },
  80: { label: 'Rovesci deboli', icon: CloudRain, type: 'rain' },
  81: { label: 'Rovesci moderati', icon: CloudRain, type: 'rain' },
  82: { label: 'Rovesci violenti', icon: CloudRain, type: 'rain' },
  85: { label: 'Rovesci di neve deboli', icon: CloudSnow, type: 'snow' },
  86: { label: 'Rovesci di neve forti', icon: CloudSnow, type: 'snow' },
  95: { label: 'Temporale', icon: CloudLightning, type: 'thunder' },
  96: { label: 'Temporale con grandine', icon: CloudLightning, type: 'thunder' },
  99: { label: 'Temporale con forte grandine', icon: CloudLightning, type: 'thunder' },
};

function getWeatherInfo(code) {
  return WMO_CODES[code] || { label: 'N.D.', icon: Cloud, type: 'cloudy' };
}

const DEFAULT_CITY = {
  name: 'Milano',
  country: 'Italia',
  latitude: 45.4642,
  longitude: 9.1900,
  admin1: 'Lombardia'
};

const POPULAR_CITIES = [
  { name: 'Milano', latitude: 45.4642, longitude: 9.1900, admin1: 'Lombardia' },
  { name: 'Roma', latitude: 41.8919, longitude: 12.5113, admin1: 'Lazio' },
  { name: 'Torino', latitude: 45.0703, longitude: 7.6869, admin1: 'Piemonte' },
  { name: 'Bologna', latitude: 44.4949, longitude: 11.3426, admin1: 'Emilia-Romagna' },
  { name: 'Firenze', latitude: 43.7696, longitude: 11.2558, admin1: 'Toscana' },
  { name: 'Napoli', latitude: 40.8518, longitude: 14.2681, admin1: 'Campania' },
];

export function useWeather() {
  const [now, setNow] = useState(new Date());
  const [city, setCity] = useState(() => {
    try {
      const saved = localStorage.getItem('hiplan_weather_city');
      return saved ? JSON.parse(saved) : DEFAULT_CITY;
    } catch {
      return DEFAULT_CITY;
    }
  });

  const [weatherData, setWeatherData] = useState(null);
  const [loadingWeather, setLoadingWeather] = useState(false);
  const [weatherError, setWeatherError] = useState(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  // Ricerca città
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showSearchDropdown, setShowSearchDropdown] = useState(false);
  const searchInputRef = useRef(null);

  // Orologio in tempo reale ogni secondo
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Fetch meteo con Open-Meteo
  const fetchWeather = async (targetCity = city) => {
    if (!targetCity?.latitude || !targetCity?.longitude) return;
    setLoadingWeather(true);
    setWeatherError(null);

    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${targetCity.latitude}&longitude=${targetCity.longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m&hourly=temperature_2m,apparent_temperature,precipitation_probability,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max&timezone=auto`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Errore HTTP ${res.status}`);
      const data = await res.json();
      setWeatherData(data);
    } catch (err) {
      console.warn('Impossibile caricare il meteo:', err);
      setWeatherError('Dati meteo non disponibili');
    } finally {
      setLoadingWeather(false);
    }
  };

  useEffect(() => {
    fetchWeather(city);
    // Refresh meteo ogni 20 minuti
    const interval = setInterval(() => fetchWeather(city), 20 * 60 * 1000);
    return () => clearInterval(interval);
  }, [city?.latitude, city?.longitude]);

  // Seleziona nuova città
  const handleSelectCity = (newCity) => {
    setCity(newCity);
    try {
      localStorage.setItem('hiplan_weather_city', JSON.stringify(newCity));
    } catch (e) { /* ignore */ }
    setShowSearchDropdown(false);
    setSearchQuery('');
    fetchWeather(newCity);
  };

  // Rilevamento posizione tramite Geolocation del browser
  const handleDetectLocation = () => {
    if (!navigator.geolocation) {
      alert('Geolocalizzazione non supportata dal tuo browser.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords;
        try {
          const res = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=it`);
          const data = await res.json();
          const detectedCity = {
            name: data.locality || data.city || 'La tua posizione',
            country: data.countryName || 'Italia',
            latitude,
            longitude,
            admin1: data.principalSubdivision || ''
          };
          handleSelectCity(detectedCity);
        } catch {
          handleSelectCity({
            name: 'La tua posizione',
            latitude,
            longitude
          });
        }
      },
      (err) => {
        console.warn('Geolocalizzazione rifiutata o non disponibile:', err);
      }
    );
  };

  // Ricerca città con Open-Meteo Geocoding
  useEffect(() => {
    if (!searchQuery.trim() || searchQuery.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setIsSearching(true);
      try {
        const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(searchQuery.trim())}&count=6&language=it&format=json`);
        const data = await res.json();
        setSearchResults(data.results || []);
        setShowSearchDropdown(true);
      } catch (err) {
        console.warn('Errore ricerca città:', err);
      } finally {
        setIsSearching(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Formattazione Data e Ora italiana
  const todayLabel = useMemo(() => {
    return now.toLocaleDateString('it-IT', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    });
  }, [now]);

  const timeLabel = useMemo(() => {
    return now.toLocaleTimeString('it-IT', {
      hour: '2-digit',
      minute: '2-digit',
    });
  }, [now]);

  // Dati meteo correnti estratti
  const currentInfo = useMemo(() => {
    if (!weatherData?.current) return null;
    const { temperature_2m, apparent_temperature, weather_code, relative_humidity_2m, wind_speed_10m } = weatherData.current;
    const info = getWeatherInfo(weather_code);
    return {
      temp: Math.round(temperature_2m),
      apparent: Math.round(apparent_temperature),
      humidity: relative_humidity_2m,
      wind: Math.round(wind_speed_10m),
      ...info
    };
  }, [weatherData]);

  const [selectedForecastDay, setSelectedForecastDay] = useState(null);

  // Previsioni 7 giorni
  const dailyForecast = useMemo(() => {
    if (!weatherData?.daily?.time) return [];
    const { time, weather_code, temperature_2m_max, temperature_2m_min, precipitation_probability_max } = weatherData.daily;
    return time.map((dateStr, idx) => {
      const d = new Date(dateStr + 'T00:00:00');
      const isToday = idx === 0;
      const dayName = isToday
        ? 'Oggi'
        : d.toLocaleDateString('it-IT', { weekday: 'short' });
      const dayFormatted = d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
      const info = getWeatherInfo(weather_code[idx]);
      return {
        dateStr,
        dayName,
        dayFormatted,
        isToday,
        maxTemp: Math.round(temperature_2m_max[idx]),
        minTemp: Math.round(temperature_2m_min[idx]),
        precipProb: precipitation_probability_max[idx] || 0,
        ...info
      };
    });
  }, [weatherData]);

  // Previsioni orarie
  const hourlyForecast = useMemo(() => {
    if (!weatherData?.hourly?.time) return [];
    const { time, temperature_2m, weather_code, precipitation_probability, wind_speed_10m } = weatherData.hourly;

    const todayDateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const currentHourStr = `${String(now.getHours()).padStart(2, '0')}:00`;
    const nowIsoPrefix = `${todayDateStr}T${currentHourStr}`;

    // Se l'utente ha cliccato su un giorno specifico dai 7 giorni
    if (selectedForecastDay) {
      const dayHours = [];
      for (let i = 0; i < time.length; i++) {
        const t = time[i];
        if (t.startsWith(selectedForecastDay)) {
          const hourStr = t.split('T')[1] || '';
          const info = getWeatherInfo(weather_code ? weather_code[i] : 0);
          dayHours.push({
            timeStr: t,
            hourLabel: hourStr,
            dayShort: null,
            temp: Math.round(temperature_2m[i]),
            precipProb: precipitation_probability ? (precipitation_probability[i] || 0) : 0,
            wind: wind_speed_10m ? Math.round(wind_speed_10m[i] || 0) : 0,
            isNow: t.startsWith(nowIsoPrefix),
            ...info
          });
        }
      }
      return dayHours;
    }

    // Default: Prossime 24 ore a partire dall'ora attuale
    let startIdx = time.findIndex(t => t >= nowIsoPrefix);
    if (startIdx === -1) {
      startIdx = Math.max(0, time.length - 24);
    }

    const nextHours = [];
    const endIdx = Math.min(time.length, startIdx + 24);
    for (let i = startIdx; i < endIdx; i++) {
      const t = time[i];
      const datePart = t.split('T')[0];
      const hourStr = t.split('T')[1] || '';
      const isNow = (i === startIdx);
      const isTomorrow = datePart !== todayDateStr;

      let dayShort = null;
      if (isTomorrow) {
        try {
          const d = new Date(datePart + 'T00:00:00');
          dayShort = d.toLocaleDateString('it-IT', { weekday: 'short' });
        } catch {
          dayShort = 'Dom';
        }
      }

      const info = getWeatherInfo(weather_code ? weather_code[i] : 0);
      nextHours.push({
        timeStr: t,
        hourLabel: isNow ? 'Adesso' : hourStr,
        fullHour: hourStr,
        dayShort,
        temp: Math.round(temperature_2m[i]),
        precipProb: precipitation_probability ? (precipitation_probability[i] || 0) : 0,
        wind: wind_speed_10m ? Math.round(wind_speed_10m[i] || 0) : 0,
        isNow,
        ...info
      });
    }
    return nextHours;
  }, [weatherData, selectedForecastDay, now]);

  return {
    now,
    city,
    setCity,
    weatherData,
    loadingWeather,
    weatherError,
    isModalOpen,
    setIsModalOpen,
    searchQuery,
    setSearchQuery,
    searchResults,
    isSearching,
    showSearchDropdown,
    setShowSearchDropdown,
    searchInputRef,
    fetchWeather,
    handleSelectCity,
    handleDetectLocation,
    todayLabel,
    timeLabel,
    currentInfo,
    dailyForecast,
    hourlyForecast,
    selectedForecastDay,
    setSelectedForecastDay,
  };
}

export function WeatherModal({ isOpen, onClose, weatherState }) {
  if (!isOpen || !weatherState) return null;

  const {
    city,
    loadingWeather,
    weatherError,
    currentInfo,
    dailyForecast,
    hourlyForecast,
    selectedForecastDay,
    setSelectedForecastDay,
    searchQuery,
    setSearchQuery,
    searchResults,
    showSearchDropdown,
    setShowSearchDropdown,
    searchInputRef,
    fetchWeather,
    handleSelectCity,
    handleDetectLocation,
  } = weatherState;

  const hourlyScrollRef = useRef(null);

  const scrollHourly = (direction) => {
    if (hourlyScrollRef.current) {
      const scrollAmount = direction === 'left' ? -380 : 380;
      hourlyScrollRef.current.scrollBy({ left: scrollAmount, behavior: 'smooth' });
    }
  };

  const CurrentIcon = currentInfo ? currentInfo.icon : CloudSun;

  return (
    <div className="weather-modal-overlay" onClick={onClose}>
      <div className="weather-modal-card" onClick={(e) => e.stopPropagation()}>
        {/* Header del Modal */}
        <div className="weather-modal-header">
          <div className="weather-modal-location">
            <MapPin size={18} className="weather-location-pin" />
            <div className="weather-location-text">
              <h3>{city?.name}</h3>
              {city?.admin1 && <span>{city.admin1}, {city?.country || 'Italia'}</span>}
            </div>
          </div>

          <div className="weather-modal-header-actions">
            <button
              type="button"
              className="weather-header-btn"
              onClick={handleDetectLocation}
              title="Usa la tua posizione attuale (GPS)"
            >
              <Compass size={15} />
              <span>GPS</span>
            </button>
            <button
              type="button"
              className="weather-header-btn"
              onClick={() => fetchWeather(city)}
              disabled={loadingWeather}
              title="Aggiorna dati meteo"
            >
              <RefreshCw size={15} className={loadingWeather ? 'spin' : ''} />
            </button>
            <button
              type="button"
              className="weather-modal-close"
              onClick={onClose}
              title="Chiudi"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Barra ricerca / cambio città con quick chips in linea */}
        <div className="weather-search-bar">
          <div className="weather-search-input-wrapper">
            <Search size={14} className="weather-search-icon" />
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Cerca un'altra città (es. Roma, Bologna, Torino)..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onFocus={() => { if (searchResults.length > 0) setShowSearchDropdown(true); }}
            />
            {searchQuery && (
              <button
                type="button"
                className="weather-search-clear"
                onClick={() => { setSearchQuery(''); }}
              >
                <X size={12} />
              </button>
            )}

            {/* Dropdown risultati ricerca */}
            {showSearchDropdown && searchResults.length > 0 && (
              <div className="weather-search-dropdown">
                {searchResults.map((r) => (
                  <div
                    key={r.id}
                    className="weather-search-item"
                    onClick={() => handleSelectCity({
                      name: r.name,
                      country: r.country,
                      admin1: r.admin1,
                      latitude: r.latitude,
                      longitude: r.longitude
                    })}
                  >
                    <MapPin size={13} />
                    <strong>{r.name}</strong>
                    <span>{r.admin1 ? `${r.admin1}, ` : ''}{r.country}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Quick Picks città famose */}
          <div className="weather-quick-cities">
            {POPULAR_CITIES.map((c) => (
              <button
                key={c.name}
                type="button"
                className={`weather-quick-city-chip ${city?.name === c.name ? 'is-active' : ''}`}
                onClick={() => handleSelectCity(c)}
              >
                {city?.name === c.name && <Check size={11} />}
                {c.name}
              </button>
            ))}
          </div>
        </div>

        {/* Griglia Superiore: Meteo Attuale + Previsioni Orarie affiancate */}
        <div className="weather-modal-top-grid">
          {/* Colonna Sinistra: Hero Card Condizioni Attuali */}
          {currentInfo ? (
            <div className={`weather-hero-card weather-theme-${currentInfo.type}`}>
              <div className="weather-hero-badge-tag">Meteo Attuale</div>
              <div className="weather-hero-main">
                <div className="weather-hero-icon-wrap">
                  <CurrentIcon size={52} className="weather-hero-icon" />
                </div>
                <div className="weather-hero-temp-block">
                  <div className="weather-hero-temp">
                    {currentInfo.temp}<span>°C</span>
                  </div>
                  <div className="weather-hero-condition">
                    {currentInfo.label}
                  </div>
                  <div className="weather-hero-perceived">
                    Percepita: {currentInfo.apparent}°C
                  </div>
                </div>
              </div>

              <div className="weather-hero-stats">
                <div className="weather-stat-item">
                  <div className="weather-stat-icon"><Thermometer size={15} /></div>
                  <div className="weather-stat-info">
                    <span>Min / Max</span>
                    <strong>{dailyForecast[0]?.minTemp ?? '-'}° / {dailyForecast[0]?.maxTemp ?? '-'}°</strong>
                  </div>
                </div>

                <div className="weather-stat-item">
                  <div className="weather-stat-icon"><Droplets size={15} /></div>
                  <div className="weather-stat-info">
                    <span>Umidità</span>
                    <strong>{currentInfo.humidity}%</strong>
                  </div>
                </div>

                <div className="weather-stat-item">
                  <div className="weather-stat-icon"><Wind size={15} /></div>
                  <div className="weather-stat-info">
                    <span>Vento</span>
                    <strong>{currentInfo.wind} km/h</strong>
                  </div>
                </div>

                <div className="weather-stat-item">
                  <div className="weather-stat-icon"><CloudRain size={15} /></div>
                  <div className="weather-stat-info">
                    <span>Pioggia oggi</span>
                    <strong>{dailyForecast[0]?.precipProb ?? 0}%</strong>
                  </div>
                </div>
              </div>
            </div>
          ) : loadingWeather ? (
            <div className="weather-hero-loading">
              <RefreshCw size={24} className="spin" />
              <span>Caricamento meteo...</span>
            </div>
          ) : weatherError ? (
            <div className="weather-hero-error">
              <p>{weatherError}</p>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => fetchWeather(city)}>
                Riprova
              </button>
            </div>
          ) : null}

          {/* Colonna Destra: Previsioni Orarie */}
          {hourlyForecast && hourlyForecast.length > 0 && (
            <div className="weather-hourly-panel">
              <div className="weather-hourly-header">
                <div className="weather-hourly-title">
                  <Clock size={16} className="weather-section-icon" />
                  <span>
                    {selectedForecastDay ? (
                      <>
                        Ore di <strong style={{ color: 'var(--text-primary)', textTransform: 'capitalize' }}>{new Date(selectedForecastDay + 'T00:00:00').toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' })}</strong>
                      </>
                    ) : (
                      'Previsioni Orarie (Prossime 24 Ore)'
                    )}
                  </span>
                </div>

                <div className="weather-hourly-actions">
                  {selectedForecastDay && (
                    <button
                      type="button"
                      className="weather-header-btn"
                      onClick={() => setSelectedForecastDay(null)}
                      title="Torna alle prossime 24 ore live"
                    >
                      <span>24h live</span>
                    </button>
                  )}
                  <div className="weather-scroll-controls">
                    <button
                      type="button"
                      className="weather-scroll-btn"
                      onClick={() => scrollHourly('left')}
                      title="Scorri ore precedenti"
                    >
                      <ChevronLeft size={16} />
                    </button>
                    <button
                      type="button"
                      className="weather-scroll-btn"
                      onClick={() => scrollHourly('right')}
                      title="Scorri ore successive"
                    >
                      <ChevronRight size={16} />
                    </button>
                  </div>
                </div>
              </div>

              <div className="weather-hourly-scroll" ref={hourlyScrollRef}>
                {hourlyForecast.map((hour, idx) => {
                  const HourIcon = hour.icon;
                  return (
                    <div
                      key={hour.timeStr || idx}
                      className={`weather-hour-card ${hour.isNow ? 'is-now' : ''}`}
                    >
                      <div className="weather-hour-time">
                        {hour.hourLabel}
                      </div>
                      {hour.dayShort && (
                        <span className="weather-hour-day">{hour.dayShort}</span>
                      )}

                      <div className="weather-hour-icon-wrap" title={hour.label}>
                        <HourIcon size={24} className="weather-hour-icon" />
                      </div>

                      <div className="weather-hour-temp">
                        {hour.temp}°
                      </div>

                      {hour.precipProb > 0 ? (
                        <div className="weather-hour-rain" title="Probabilità di pioggia">
                          <Droplets size={10} />
                          <span>{hour.precipProb}%</span>
                        </div>
                      ) : (
                        <div className="weather-hour-rain weather-hour-rain--dry" title="Asciutto">
                          <span>0%</span>
                        </div>
                      )}

                      {hour.wind > 0 && (
                        <div className="weather-hour-wind" title={`Vento ${hour.wind} km/h`}>
                          <Wind size={9} />
                          <span>{hour.wind}k</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Previsioni Settimanali (7 Giorni) */}
        <div className="weather-forecast-section">
          <div className="weather-forecast-header">
            <div className="weather-forecast-title">
              <Calendar size={15} className="weather-section-icon" />
              <span>Previsioni Prossimi 7 Giorni</span>
              <span className="weather-forecast-hint">
                (clicca per visualizzare le ore del giorno)
              </span>
            </div>
            <span className="weather-source-badge">Dati meteo live Open-Meteo</span>
          </div>

          <div className="weather-forecast-grid">
            {dailyForecast.map((day) => {
              const DayIcon = day.icon;
              const isSelected = selectedForecastDay === day.dateStr;
              return (
                <div
                  key={day.dateStr}
                  className={`weather-day-card ${day.isToday ? 'is-today' : ''} ${isSelected ? 'is-selected' : ''}`}
                  onClick={() => setSelectedForecastDay(isSelected ? null : day.dateStr)}
                  role="button"
                  tabIndex={0}
                  title={`Clicca per visualizzare il dettaglio orario di ${day.dayName} ${day.dayFormatted}`}
                >
                  <div className="weather-day-header">
                    <strong>{day.dayName}</strong>
                    <span>{day.dayFormatted}</span>
                  </div>

                  <div className="weather-day-icon-wrap" title={day.label}>
                    <DayIcon size={26} className="weather-day-icon" />
                  </div>

                  <div className="weather-day-condition" title={day.label}>
                    {day.label}
                  </div>

                  <div className="weather-day-temps">
                    <span className="temp-max">{day.maxTemp}°</span>
                    <div className="temp-bar-wrap">
                      <div className="temp-bar" />
                    </div>
                    <span className="temp-min">{day.minTemp}°</span>
                  </div>

                  {day.precipProb > 0 ? (
                    <div className="weather-day-rain" title="Probabilità di precipitazioni">
                      <Droplets size={10} />
                      <span>{day.precipProb}%</span>
                    </div>
                  ) : (
                    <div className="weather-day-rain weather-day-rain--dry">
                      <span>0%</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="weather-modal-footer">
          <span className="weather-disclaimer">
            📍 Le previsioni vengono aggiornate automaticamente in base alla città selezionata.
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onClose}
          >
            Chiudi
          </button>
        </div>
      </div>
    </div>
  );
}

export default function WeatherDateWidget() {
  const weatherState = useWeather();
  const { todayLabel, timeLabel, currentInfo, city, loadingWeather, isModalOpen, setIsModalOpen } = weatherState;
  const CurrentIcon = currentInfo ? currentInfo.icon : CloudSun;

  return (
    <>
      <div
        className="weather-date-pill"
        onClick={() => setIsModalOpen(true)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setIsModalOpen(true); }}
        title="Clicca per visualizzare le previsioni meteo della settimana"
      >
        <span className="weather-date-dot" />
        <span className="weather-date-datetime">{todayLabel} · {timeLabel}</span>

        {currentInfo ? (
          <>
            <span className="weather-date-divider">|</span>
            <div className={`weather-pill-badge weather-badge--${currentInfo.type}`}>
              <CurrentIcon size={15} className="weather-pill-icon" />
              <span className="weather-pill-temp">{currentInfo.temp}°C</span>
              <span className="weather-pill-city">{city?.name}</span>
            </div>
          </>
        ) : loadingWeather ? (
          <>
            <span className="weather-date-divider">|</span>
            <span className="weather-pill-loading">Meteo...</span>
          </>
        ) : null}
      </div>

      <WeatherModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        weatherState={weatherState}
      />
    </>
  );
}
