/**
 * Utility functions for custom_dates tasks (parsing, sorting, and contiguous clustering).
 */

export function getCustomDatesList(task) {
  if (!task || !task.custom_dates) return [];
  let list = task.custom_dates;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list
    .map(item => {
      if (typeof item === 'string') return { date: item, hours: 8 };
      if (item && item.date) return { date: item.date, hours: Number(item.hours) || 8 };
      return null;
    })
    .filter(Boolean);
}

export function clusterCustomDates(customDatesList) {
  if (!customDatesList || customDatesList.length === 0) return [];

  const sorted = [...customDatesList]
    .map(item => {
      const d = typeof item === 'string' ? item : item.date;
      const h = typeof item === 'object' && item.hours ? Number(item.hours) : 8;
      return { date: d, hours: h };
    })
    .filter(x => Boolean(x.date))
    .sort((a, b) => a.date.localeCompare(b.date));

  const clusters = [];
  let curCluster = null;

  for (const item of sorted) {
    const itemDate = new Date(item.date + 'T00:00:00');
    if (isNaN(itemDate)) continue;

    if (!curCluster) {
      curCluster = {
        startDateStr: item.date,
        endDateStr: item.date,
        hours: item.hours,
        dates: [item.date]
      };
    } else {
      const prevDate = new Date(curCluster.endDateStr + 'T00:00:00');
      const diffMs = itemDate.getTime() - prevDate.getTime();
      const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

      if (diffDays === 1) {
        curCluster.endDateStr = item.date;
        curCluster.hours = Math.round((curCluster.hours + item.hours) * 100) / 100;
        curCluster.dates.push(item.date);
      } else {
        clusters.push(curCluster);
        curCluster = {
          startDateStr: item.date,
          endDateStr: item.date,
          hours: item.hours,
          dates: [item.date]
        };
      }
    }
  }
  if (curCluster) {
    clusters.push(curCluster);
  }

  return clusters;
}
