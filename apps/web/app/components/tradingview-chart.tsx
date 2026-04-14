'use client';

import { useEffect, useRef } from 'react';
import {
  ColorType,
  createChart,
  CrosshairMode,
  LastPriceAnimationMode,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type UTCTimestamp,
} from 'lightweight-charts';

type TradingViewPoint = {
  timestamp: number;
  price: number;
};

type TradingViewSeries = {
  marketId: string;
  exchangeName: string;
  symbol: string;
  instrumentType: 'spot' | 'futures';
  color: string;
  points: TradingViewPoint[];
};

type TradingViewChartProps = {
  ariaLabel: string;
  chartMode: 'price' | 'premium';
  chartTimeframe: 'tick' | '1m' | '5m' | '15m';
  series: TradingViewSeries[];
};

function normalizeLineData(points: TradingViewPoint[]) {
  const pointMap = new Map<number, number>();

  for (const point of points) {
    pointMap.set(point.timestamp, point.price);
  }

  return Array.from(pointMap.entries())
    .sort((left, right) => left[0] - right[0])
    .map(([timestamp, price]) => ({
      time: Math.floor(timestamp / 1000) as UTCTimestamp,
      value: price,
    })) satisfies LineData[];
}

export function TradingViewChart({ ariaLabel, chartMode, chartTimeframe, series }: TradingViewChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRefs = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    const chart = createChart(containerRef.current, {
      autoSize: true,
      height: 360,
      layout: {
        background: { type: ColorType.Solid, color: '#0b1220' },
        textColor: '#cbd5e1',
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(59, 130, 246, 0.10)' },
        horzLines: { color: 'rgba(148, 163, 184, 0.14)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: 'rgba(96, 165, 250, 0.35)',
          width: 1,
          labelBackgroundColor: '#2563eb',
        },
        horzLine: {
          color: 'rgba(148, 163, 184, 0.35)',
          width: 1,
          labelBackgroundColor: '#1e293b',
        },
      },
      rightPriceScale: {
        borderColor: 'rgba(148, 163, 184, 0.20)',
        scaleMargins: { top: 0.14, bottom: 0.14 },
      },
      timeScale: {
        borderColor: 'rgba(148, 163, 184, 0.20)',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 6,
        barSpacing: 22,
      },
      handleScroll: true,
      handleScale: true,
    });

    chartRef.current = chart;

    const resizeObserver = new ResizeObserver(() => {
      chart.timeScale().fitContent();
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      seriesRefs.current.clear();
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) {
      return;
    }

    chart.applyOptions({
      localization: {
        locale: 'ko-KR',
        priceFormatter: (value: number) => (chartMode === 'price' ? `$${value.toFixed(value >= 100 ? 2 : 4)}` : `${value >= 0 ? '+' : ''}${value.toFixed(3)}%`),
      },
      timeScale: {
        secondsVisible: chartTimeframe === 'tick',
        barSpacing: chartTimeframe === '15m' ? 64 : chartTimeframe === '5m' ? 34 : chartTimeframe === '1m' ? 22 : 16,
      },
    });

    const nextSeriesIds = new Set(series.map((entry) => entry.marketId));

    for (const [marketId, lineSeries] of seriesRefs.current.entries()) {
      if (!nextSeriesIds.has(marketId)) {
        chart.removeSeries(lineSeries);
        seriesRefs.current.delete(marketId);
      }
    }

    for (const entry of series) {
      let lineSeries = seriesRefs.current.get(entry.marketId);
      if (!lineSeries) {
        lineSeries = chart.addSeries(LineSeries, {
          color: entry.color,
          lineWidth: 2,
          lineStyle: entry.instrumentType === 'futures' ? LineStyle.LargeDashed : LineStyle.Solid,
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerVisible: true,
          crosshairMarkerRadius: 4,
          lastPriceAnimation: LastPriceAnimationMode.OnDataUpdate,
        });
        seriesRefs.current.set(entry.marketId, lineSeries);
      } else {
        lineSeries.applyOptions({
          color: entry.color,
          lineStyle: entry.instrumentType === 'futures' ? LineStyle.LargeDashed : LineStyle.Solid,
        });
      }

      const lineData = normalizeLineData(entry.points);
      lineSeries.setData(lineData);
    }

    chart.timeScale().fitContent();
  }, [chartMode, chartTimeframe, series]);

  return <div ref={containerRef} className="tradingview-chart-wrap" role="img" aria-label={ariaLabel} />;
}
