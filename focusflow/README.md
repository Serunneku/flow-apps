# FocusFlow

Une petite app web (PWA) pour gérer ses tâches du jour et suivre ses habitudes, sans backend, 100% hors-ligne.

## Fonctionnalités

- Liste de tâches simple (ajouter, cocher, supprimer)
- Suivi d'habitudes quotidiennes avec compteur de série (streak)
- Fonctionne hors-ligne (service worker)
- Installable sur l'écran d'accueil iPhone et comme app sur Mac (Safari/Chrome)
- Toutes les données restent en local (localStorage), rien n'est envoyé à un serveur

## Utiliser en local

Ouvrir `index.html` via un serveur local (nécessaire pour que le service worker fonctionne) :

```bash
cd focusflow
python3 -m http.server 8080
```

Puis ouvrir `http://localhost:8080` dans le navigateur.

## Installer sur iPhone

1. Ouvrir le site dans Safari
2. Bouton "Partager" → "Sur l'écran d'accueil"

## Installer sur Mac

- Safari : menu Fichier → "Ajouter au Dock"
- Chrome/Edge : icône d'installation dans la barre d'adresse
