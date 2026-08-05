# Apple TV

Contrôlez votre Apple TV depuis Gladys Assistant : alimentation, télécommande,
lecture, volume et applications. L'intégration parle directement à votre Apple TV
sur votre réseau local, avec [pyatv](https://pyatv.dev) — l'implémentation de
référence des protocoles AirPlay et Companion d'Apple, celle qu'utilise aussi
Home Assistant. Rien ne passe par les serveurs d'Apple, aucun identifiant Apple
n'est nécessaire.

## Prérequis

- Une Apple TV (HD, 4K, toute génération sous tvOS 15 ou plus récent).
- L'Apple TV et votre serveur Gladys sur le **même réseau**. S'ils sont sur des
  VLAN ou sous-réseaux différents, voir « Réseaux séparés » plus bas.
- Un accès physique au téléviseur pendant l'appairage : Apple affiche un code à
  l'écran, que vous devez lire et saisir dans Gladys.

## Mise en route

### 1. Trouver votre Apple TV

Ouvrez l'onglet **Découverte** de l'intégration et lancez une recherche. Gladys
écoute les annonces AirPlay de votre réseau, et l'intégration vérifie chaque
adresse candidate directement avec pyatv. Votre Apple TV apparaît avec son nom
et son modèle.

Cliquez sur **Ajouter** pour créer l'appareil dans Gladys. Une Apple TV porte
généralement le nom de la pièce où elle se trouve (« Séjour ») : l'appareil est
donc créé sous le nom « Apple TV Séjour » — lisible dans une liste d'appareils,
et c'est aussi ce qui rend son sélecteur lisible dans les scènes. Vous pouvez le
renommer ensuite dans l'onglet Appareils.

### 2. L'appairer

L'appairage autorise Gladys à contrôler l'appareil. Il se fait dans l'onglet
**Configuration**, avec les deux premiers boutons :

1. **Appairer une Apple TV** — saisissez l'adresse IP de votre Apple TV, ou son
   nom si vous l'avez déjà ajoutée. Laissez le champ vide si vous n'en avez
   qu'une. Un code s'affiche sur votre téléviseur.
2. **Saisir le code** — tapez le code affiché à l'écran.

Vous pouvez appairer avant d'ajouter l'appareil : l'adresse IP suffit.

Apple demande un code **par protocole** : une fois le premier code accepté, un
second s'affiche sur le téléviseur. Deux codes, c'est normal.

Le second code se saisit **dans le même champ que le premier**. Le formulaire
conserve ce que vous avez tapé : il faut donc **effacer le champ et saisir le
nouveau code à la place**, puis relancer le bouton. Relancer sans effacer ne
sert à rien — l'intégration reconnaît l'ancien code et vous le dit, plutôt que
de gâcher le nouveau.

Les codes expirent vite, et la connexion qui les porte se ferme d'elle-même au
bout d'un moment. Si cela arrive, l'intégration vous le dit et affiche
immédiatement un **nouveau code** sur votre téléviseur : lisez le message,
effacez le champ, saisissez le nouveau code, et continuez. Inutile de repartir
de l'étape 1.

Une fois l'appairage terminé, relancez une recherche (ou acceptez la **mise à
jour** que Gladys propose dans l'onglet Découverte) : l'intégration connaît
maintenant les capacités réelles de votre Apple TV et ajoute le contrôle du
volume et les raccourcis d'applications.

### 3. L'utiliser

L'appareil expose :

- **Alimentation** — allumé/éteint. « Éteint » signifie veille, au sens d'Apple :
  le boîtier reste sur le réseau, l'écran et la sortie HDMI s'éteignent.
- **Télécommande** — croix directionnelle, OK, Retour, Accueil, Centre de
  contrôle.
- **Lecture** — lecture, pause, stop, précédent, suivant, retour et avance
  rapide.
- **Volume** — un curseur, ainsi que des boutons volume +/−. Le curseur
  n'apparaît que si votre installation expose un niveau de volume lisible. Une
  Apple TV qui pilote une barre de son en HDMI-CEC ne gère généralement que les
  boutons +/−.
- **Lecture en cours** et **Application** — capteurs texte indiquant ce qui est
  à l'écran.
- **Raccourcis d'applications** — un bouton par application installée, pour
  qu'une scène ouvre Netflix ou Disney+ directement. Désactivables, ou limitables
  en nombre, dans la configuration.

### Sur un tableau de bord

Deux boîtes, deux façons d'utiliser la même Apple TV :

- **Appareils d'une pièce** — chaque touche de la télécommande est un vrai
  bouton cliquable : croix directionnelle, OK, Retour, Accueil, Centre de
  contrôle, lecture, pause, touches de transport, curseur de volume et
  raccourcis d'applications. C'est la télécommande.
- **Boîte Musique** — la barre de transport d'un lecteur multimédia. Ajoutez-y
  l'Apple TV et pilotez-la comme un Sonos.

La liste des fonctionnalités contient les deux jeux, d'où certaines touches en
double : celles préfixées « Media » servent à la boîte Musique, les autres sont
les boutons de la télécommande. Chaque boîte ne propose que ce qu'elle sait
utiliser, vous n'avez donc jamais à choisir.

## Configuration

| Réglage                        | Effet                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Durée de la recherche          | Durée d'écoute des annonces AirPlay. À augmenter sur un réseau chargé ou lent.                                                       |
| Adresses IPv4 manuelles        | Utile uniquement si les annonces n'arrivent pas jusqu'à Gladys (réseaux routés, VLAN). S'ajoutent à la découverte automatique.       |
| Intervalle de rafraîchissement | Fréquence de réconciliation de ce que l'Apple TV ne pousse pas d'elle-même, généralement l'état d'alimentation sur certains modèles. |
| Raccourcis d'applications      | Exposer ou non un bouton par application installée.                                                                                  |
| Nombre maximum de raccourcis   | Une Apple TV peut compter une centaine d'applications ; cette limite garde l'appareil lisible.                                       |

## Autres actions

- **Reconnecter et actualiser** — rouvre la session et relit l'appareil. La
  première chose à essayer quand un état semble figé.
- **Lister les applications installées** — affiche l'identifiant de chaque
  application, celui qu'attend « Lancer une application ».
- **Lancer une application** — ouvre une application par son identifiant, par
  exemple `com.netflix.Netflix`.
- **Lire une URL** — envoie une URL vidéo ou un lien profond à l'Apple TV via
  AirPlay.
- **Supprimer l'appairage** — oublie les identifiants enregistrés. À utiliser
  lorsque l'appairage doit être refait, par exemple après une réinitialisation de
  l'Apple TV.

## Dépannage

**La recherche ne trouve rien.** Gladys capte les annonces AirPlay depuis le
réseau de l'hôte. Vérifiez que votre Apple TV est allumée, qu'AirPlay est activé
(Réglages → AirPlay et HomeKit) et que Gladys est sur le même réseau. Si votre
serveur Gladys est sur un autre sous-réseau, renseignez l'adresse IPv4 manuelle.

Le journal de l'intégration nomme ce qu'il a vu : s'il signale des annonces
« sans adresse IPv4 », votre Apple TV _a bien_ été annoncée mais son adresse
n'est jamais arrivée jusqu'à Gladys — passez directement par l'adresse manuelle.

**Vous faites tourner Gladys dans Docker sur un Mac ou sous Windows.** La
découverte automatique ne peut pas fonctionner là, et ce n'est pas une erreur de
configuration de votre part. Docker Desktop, OrbStack et Colima exécutent les
conteneurs dans une machine virtuelle Linux : `network_mode: host` désigne donc
le réseau _de la machine virtuelle_, pas votre wifi. Le multicast émis par votre
Apple TV n'atteint jamais Gladys. L'unicast, lui, passe : renseignez l'adresse IP
de votre Apple TV dans « Adresses IPv4 manuelles » et l'intégration la découvre,
l'appaire et la pilote normalement. Un Gladys installé sur Linux (Raspberry Pi,
NAS, serveur) est réellement sur le réseau et n'a pas besoin de cela.

**Toutes les commandes échouent avec « pas encore appairée ».** L'appareil a été
ajouté mais jamais appairé. Lancez les deux boutons d'appairage dans l'onglet
Configuration.

**L'appairage échoue ou le code est refusé.** Le code expire vite — relancez
l'étape 1 et saisissez-le immédiatement. Si l'échec persiste, retirez Gladys de
l'Apple TV (Réglages → Général → AirPlay et HomeKit → Autoriser l'accès), lancez
« Supprimer l'appairage » dans Gladys, puis recommencez.

**L'appareil est indiqué injoignable.** Vérifiez que l'Apple TV est allumée et
qu'elle a toujours la même adresse IP. Une recherche met à jour l'adresse
utilisée par l'intégration ; un bail statique sur votre routeur évite le problème.

**Il n'y a pas de curseur de volume.** Votre installation n'expose pas de niveau
de volume lisible — cas fréquent en HDMI-CEC. Utilisez les boutons volume +/−.

**Réseaux séparés.** Les annonces mDNS ne traversent pas les sous-réseaux.
Renseignez l'adresse IPv4 de chaque Apple TV dans « Adresses IPv4 manuelles » :
l'intégration les interroge directement, ce qui fonctionne tant que le trafic est
routé.

## Confidentialité et stockage

Les identifiants d'appairage sont stockés dans le volume dédié de l'intégration
(`/data/pyatv.json`), jamais dans la configuration de Gladys, et ne quittent
jamais votre réseau. Supprimer l'intégration les supprime avec elle.
