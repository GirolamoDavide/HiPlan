# Guida utente di HiPlan

HiPlan riunisce pianificazione delle commesse, attività operative, ore, ferie, TODO, ticket e documentazione di lavoro. Questa guida descrive le funzionalità disponibili nell'applicazione corrente.

## 1. Accesso, ruoli e reparti

È possibile accedere usando email oppure username e password. La sessione viene mantenuta tramite access token e refresh token.

I ruoli applicativi sono:

| Ruolo | Utilizzo principale |
| --- | --- |
| `admin` | Amministrazione completa, utenti, configurazione e operazioni riservate |
| `editor` | Creazione e aggiornamento dei dati operativi consentiti |
| `viewer` | Consultazione e operazioni personali o collaborative autorizzate |

Ogni utente può essere associato a un reparto: **Ufficio Tecnico**, **Produzione**, **Acquisti**, **Commerciale** oppure **Admin**. Ruolo e reparto sono concetti distinti: il ruolo determina i permessi, il reparto organizza il lavoro.

Il primo account registrato riceve il ruolo di amministratore. L'installazione corrente crea inoltre un account amministrativo iniziale all'avvio: in produzione è indispensabile sostituirne immediatamente le credenziali predefinite.

## 2. Navigazione e profilo

Il menu laterale contiene:

- **Dashboard**: riepilogo personale e aziendale.
- **Commesse**: elenco, filtri, creazione ed export.
- **Calendario**: vista mensile delle attività.
- **Blocchi Note**: documenti privati e condivisi.
- **TODO**: attività personali o assegnate.
- **Ticket**: richieste e conversazioni operative.
- **HiPlan AI**: assistente virtuale intelligente per interrogare commesse e dati.
- **Panoramica addetti**: carico e sovrapposizioni (visibile a tutti).
- **Rilevatore Conflitti**: analisi proattiva di ritardi e conflitti (visibile agli editor e admin).
- **Admin**: configurazione riservata agli amministratori.

Nella parte inferiore sono disponibili le notifiche, la scelta del tema, il profilo e il logout. La pagina **Il mio profilo** permette di aggiornare i propri dati e gestire le ferie.

## 3. Dashboard

La Dashboard mostra:

- numero totale di commesse, commesse attive e completate;
- avanzamento medio;
- timeline mensile delle commesse e delle fasi assegnate all'utente;
- attività operative previste per la giornata;
- TODO aperti assegnati;
- avvisi relativi al rientro dalle ferie;
- commesse recenti;
- eventuali annunci globali pubblicati dagli amministratori.

È possibile cambiare mese nella timeline e aprire direttamente una commessa o un'attività dal relativo riquadro.

## 4. Commesse

### Creazione e Modifica

Dalla pagina **Commesse**, selezionare **Nuova Commessa** (oppure cliccare su *Modifica Commessa* dalla scheda di dettaglio). Il popup moderno a due colonne consente una gestione spaziosa e ordinata:

- **Colonna sinistra**: Codice e Cliente, Titolo commessa, Data di Inizio e Fine, Colore identificativo e Stato (*In Pianificazione*, *In Corso*, *Completata*, *Archiviata*), Responsabile e Note/Descrizione.
- **Colonna destra**:
  - **Tipologia Commessa**:
    - **Standard**: commessa ordinaria senza vincoli normativi speciali (selezionata automaticamente se non vi sono altri flag attivi).
    - **ATEX**: per apparecchiature destinate ad atmosfere potenzialmente esplosive soggette a direttiva ATEX e certificazioni di conformità.
    - **Alimentare**: per commesse destinate all'industria alimentare soggette a idoneità MOCA (materiali a contatto con alimenti) e protocolli igienico-sanitari.
    - *Nota*: le tipologie **ATEX** e **Alimentare** possono essere selezionate contemporaneamente per commesse ibride complesse.
  - **Addetti della Commessa**: selezione multipla rapida con badge e ricerca istantanea delle risorse del team.

Le etichette di tipologia (*Standard*, *ATEX*, *Alimentare*) compaiono con badge dedicati nelle tessere della schermata principale e nella scheda di dettaglio.

### Filtri ed export

L'elenco consente di filtrare per stato e cercare per testo. La vista personale include i progetti nei quali l'utente è responsabile o assegnato alla commessa o a una fase.

È possibile selezionare più commesse ed esportarne l'elenco in PDF o Excel.

### Dettaglio della commessa

La scheda contiene più aree operative:

- **Gantt**: pianificazione temporale interattiva, avanzamenti e dipendenze tra fasi;
- **Analisi Commessa - HiPlan AI**: audit intelligente della commessa che verifica all'istante ritardi, sovrapposizioni, conflitti con ferie e conformità normativa (ATEX/MOCA). Riporta la percentuale reale di avanzamento e suggerisce riprogrammazioni nominative e orarie precise;
- **Commessa**: informazioni generali e riepiloghi;
- **Note e allegati**: documentazione e file caricati;
- **Alert**: elementi critici che richiedono attenzione;
- **Registro attività**: cronologia completa e tracciabilità delle modifiche.

Dal dettaglio è possibile modificare i dati generali, caricare allegati ed esportare sezioni selezionate in PDF o Excel.

## 5. Fasi, milestone e Gantt

### Creazione di una fase

Una fase può includere:

- nome;
- reparto;
- priorità;
- colore;
- data iniziale e finale;
- durata in giorni lavorativi;
- budget ore;
- uno o più addetti;
- quota di ore assegnata a ciascun addetto;
- fase padre, quando si usa una struttura gerarchica.

Le modalità di calcolo permettono di partire da date, giorni oppure ore. I calcoli operativi escludono i giorni non lavorativi previsti dall'applicazione.

### Template di fase

Quando si crea una fase è possibile usare un modello predefinito per reparto. Gli editor autorizzati possono salvare una nuova denominazione come template personalizzato; gli amministratori gestiscono l'elenco completo dal pannello Admin.

### Milestone

Una milestone rappresenta un evento o una scadenza senza durata. Non richiede budget ore né assegnazione del lavoro come una fase ordinaria.

### Dipendenze

Nel Gantt è possibile collegare le fasi con quattro tipi di dipendenza:

- `FS`: la fase successiva inizia dopo la fine della precedente;
- `SS`: le due fasi iniziano in relazione;
- `FF`: le due fasi terminano in relazione;
- `SF`: la fine della fase target dipende dall'inizio della sorgente.

Il collegamento può includere un ritardo (`lag`). Le dipendenze sono visualizzate e modificabili nel Gantt; la ripianificazione automatica dell'intera catena è indicata come sviluppo futuro nella roadmap.

### Stato e avanzamento

Una fase può essere contrassegnata come completata. L'avanzamento viene riflesso nella commessa, nelle viste riepilogative e nel Gantt.

## 6. Ore pianificate e consuntive

Per ogni fase ordinaria è possibile:

- definire un budget complessivo;
- assegnare una quantità di ore ai singoli addetti;
- registrare le ore effettive per giornata e persona;
- confrontare ore previste e registrate.

La somma delle ore assegnate non può superare il budget della fase. La heatmap usa la pianificazione per evidenziare giornate libere, parzialmente occupate o sovraccariche.

Il workflow formale di invio e approvazione dei timesheet non è ancora disponibile ed è incluso nella roadmap.

## 7. Checklist, commenti e notifiche

Aprendo una fase sono disponibili tre schede:

- **Generale**: dati, date, budget, reparto e addetti;
- **Checklist**: sotto-attività spuntabili con indicatore di completamento;
- **Commenti**: conversazione contestuale alla fase.

Nei commenti è possibile menzionare un collega con `@username`. Il destinatario riceve una notifica in-app collegata alla commessa e alla fase.

La campanella nella barra laterale consente di:

- vedere le notifiche;
- contrassegnarle come lette;
- eliminarne una;
- eliminare l'intero elenco.

## 8. Calendario, addetti, ferie e intelligenza artificiale

### Calendario operativo

Il Calendario mostra le fasi sulle giornate del mese. È possibile filtrare per addetto e aprire il progetto collegato.

### Panoramica addetti

Questa sezione identifica le giornate nelle quali la stessa persona risulta impegnata su più attività. Per ogni conflitto vengono mostrate le fasi e le commesse coinvolte.

### Rilevatore Conflitti

Il **Rilevatore Conflitti** (precedentemente *Agent*) è un sistema proattivo che analizza le commesse in background, segnalando automaticamente la mancata consuntivazione delle ore, ritardi rispetto al Gantt, dati mancanti o sovraccarichi critici di lavoro. Consente all'utente di passare rapidamente alla commessa in oggetto per risolvere l'anomalia.

### HiPlan AI (Assistente Virtuale e Reportistica)

L'applicazione integra una suite completa di Intelligenza Artificiale progettata per ottimizzare la pianificazione:

1. **Assistente Virtuale (Chatbot)**:
   - Accessibile dalla barra laterale (**HiPlan AI**), permette di interrogare il sistema in linguaggio naturale.
   - Fornisce tabelle e statistiche in tempo reale su commesse attive, carichi di lavoro, scadenze imminenti e ticket.
   - Riconosce la tipologia delle commesse (*"Quali commesse sono ATEX o alimentari?"*, *"Mostrami le commesse standard del cliente Alfa"*).
   - Offre tool rapidi come il **Morning Briefing** personalizzato con le attività urgenti della giornata e le prossime scadenze.
   - Fornisce consigli operativi e chiari senza formule generaliste o superflue.

2. **Reportistica Esecutiva Direzionale (Pannello Admin)**:
   - Riservato agli amministratori, genera un resoconto strategico ad alto impatto sullo stato complessivo dell'azienda.
   - Mostra KPI sintetici con le commesse attive, in pianificazione, fasi aperte, addetti coinvolti e scadenze a 7 giorni.
   - Analizza la concentrazione dei carichi di lavoro, evidenzia criticità e ritardi reali e formula raccomandazioni decisionali mirate e nominative (es. riassegnazione carichi tra colleghi dello stesso reparto).

### Ferie

Dal profilo personale è possibile inserire un intervallo di ferie con una motivazione facoltativa e rimuovere periodi non più validi.

Quando una fase assegnata si sovrappone alle ferie:

- la fase può essere segnalata come in conflitto;
- l'utente visualizza il periodo e le attività coinvolte;
- al rientro può comparire un promemoria delle attività da recuperare.

La registrazione delle ferie non sposta automaticamente le fasi.

## 9. TODO

Un TODO comprende:

- titolo e descrizione;
- autore;
- uno o più assegnatari;
- data di notifica;
- data di scadenza;
- allegati;
- invio email opzionale;
- stato aperto o completato.

Sono disponibili filtri per stato e relazione con l'utente. Il creatore e gli utenti autorizzati possono modificare o completare il TODO.

Il backend controlla periodicamente le notifiche programmate e le scadenze imminenti. Se SMTP è configurato e l'opzione email è attiva, invia anche il messaggio ai destinatari.

## 10. Ticket

Un ticket può essere collegato a una commessa attiva oppure a un codice inserito manualmente. Contiene:

- titolo e descrizione;
- autore e responsabile;
- assegnatari;
- priorità;
- stato;
- allegati.

La scheda del ticket mantiene la conversazione, gli allegati delle singole risposte e i messaggi di sistema relativi alle variazioni di stato.

Gli stati configurati inizialmente comprendono **Da gestire**, **In attesa del cliente**, **In elaborazione** e **Completato**. L'amministratore può gestire le fasi disponibili dal pannello Admin.

I ticket possono essere esportati in PDF o Excel. Visibilità, eliminazione e riapertura dipendono dal ruolo e dal rapporto dell'utente con il ticket.

## 11. Blocchi Note

Le note possono essere:

- **private**, visibili al proprietario;
- **condivise**, accessibili al team autorizzato.

L'editor supporta formattazione visuale, titoli, enfasi, citazioni, codice e checklist. Grazie al layout a due colonne introdotto di recente, l'area di scrittura è separata dalla gestione degli allegati (sulla destra). È possibile caricare file trascinandoli ovunque all'interno della pagina (drag and drop) o cercare/filtrare le note in base alla loro visibilità.

Le modifiche vengono salvate sul server; prima di uscire da una nota è comunque opportuno verificare l'indicatore di salvataggio.

## 12. Amministrazione

Il pannello Admin comprende:

- annunci globali con tipo e scadenza;
- utenti, ruoli, reparto, stato e reset password;
- template delle fasi per reparto;
- configurazione delle fasi dei ticket;
- backup JSON e ripristino;
- data e dimensione dell'ultimo backup automatico;
- registro delle email inviate;
- notifiche email programmate e possibilità di annullarle.

Il ripristino JSON sovrascrive i dati correnti. Prima di procedere è consigliato scaricare un backup aggiornato e verificare che il file appartenga alla stessa versione applicativa.

## 13. Export e backup

Gli export PDF ed Excel sono pensati per condividere viste leggibili di commesse, fasi, Gantt, ore e ticket. Non sostituiscono il backup.

Il backup JSON amministrativo copre attualmente utenti, impostazioni, template di fase, commesse, membri, task, note, ferie, notifiche, dipendenze, commenti e checklist. Non comprende ancora ticket e risposte, TODO, log email o il contenuto fisico degli allegati.

Il backup automatico integrato archivia il database SQLite locale e gli upload. Non esegue un dump di PostgreSQL. La politica di backup dell'ambiente deve quindi includere separatamente il database in uso, la directory degli upload e una copia esterna dei file prodotti.

## 14. Funzionalità future

Le funzionalità proposte, ma non ancora disponibili, sono descritte separatamente nella [roadmap](ROADMAP.md). Questa separazione evita di confondere il comportamento corrente con le idee in valutazione.
