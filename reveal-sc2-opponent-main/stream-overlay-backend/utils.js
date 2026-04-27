// utils.js
function mmrToLeague(mmr) {
    if (!Number.isFinite(mmr) || mmr < 0) return null;
    if (mmr >= 5000) return 'Grandmaster';
    if (mmr >= 4400) return 'Master';
    if (mmr >= 3500) return 'Diamond';
    if (mmr >= 2800) return 'Platinum';
    if (mmr >= 2200) return 'Gold';
    if (mmr >= 1700) return 'Silver';
    return 'Bronze';
}

module.exports = {
    mmrToLeague
};