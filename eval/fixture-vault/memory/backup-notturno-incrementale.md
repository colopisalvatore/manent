---
name: backup-notturno-incrementale
description: "Il backup notturno incrementale del database e cosa resta fuori dallo snapshot."
type: reference
audience: [tech]
created: 2026-01-14
tags: [backup]
---

Il backup gira alle 03:00, incrementale sul giorno prima, con un dump completo la domenica. Lo
snapshot copre il database e la cartella degli allegati, non copre la cache dei vettori ne i file
temporanei: si ricostruiscono, e includerli triplicava la dimensione dell archivio.

Il ripristino va provato, non dedotto: una volta al mese si monta l ultimo archivio su una
macchina di prova e si conta il numero di righe delle tabelle principali. Un backup mai
ripristinato e una speranza, non una copia.

Vedi anche [[old-deploy-recipe]] e [[acme-hosting]] per dove finiscono gli archivi.
