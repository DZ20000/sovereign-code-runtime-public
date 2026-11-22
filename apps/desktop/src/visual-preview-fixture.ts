import type { BrowserWindow } from "electron";

/** Deterministic media made inside the isolated renderer, never from the OS or a site. */
export async function createVisualPreviewFixtures(window: BrowserWindow): Promise<{
  readonly browser: string;
  readonly computer: string;
}> {
  return window.webContents.executeJavaScript(`(() => {
    const make = (width,height,paint) => {
      const canvas=document.createElement('canvas'); canvas.width=width; canvas.height=height;
      const context=canvas.getContext('2d');
      const box=(x,y,w,h,color)=>{context.fillStyle=color;context.fillRect(x,y,w,h);};
      const text=(value,x,y,size=24,color='#20242d')=>{
        context.font=size+'px Segoe UI';context.fillStyle=color;context.fillText(value,x,y);
      };
      paint(box,text);
      return canvas.toDataURL('image/jpeg',0.88).split(',')[1];
    };
    const browser=make(1280,720,(box,text)=>{
      box(0,0,1280,720,'#f6f7f9');box(24,24,1232,608,'#ffffff');
      text('Example Domain',48,80,36);
      text('This page is a synthetic visual fixture.',48,120,22,'#626b7a');
      box(48,180,260,36,'#edf0f5');text('Search examples',60,205,18);
      box(320,180,110,36,'#5368cf');text('Run search',330,205,18,'#ffffff');
      box(48,230,260,36,'#edf0f5');text('Account password',60,255,18,'#626b7a');
      text('Synthetic browser preview — no website was opened',48,680,20,'#626b7a');
    });
    const computer=make(1920,1080,(box,text)=>{
      box(0,0,1920,1080,'#dbe4f2');
      box(120,80,1360,860,'#ffffff');box(120,80,1360,44,'#f0f2f5');
      text('Sovereign Code Runtime — synthetic fixture',144,111,22);
      box(120,124,210,816,'#f0f2f5');text('Workspace',144,172,22);
      text('Home & Connections',370,190,32);text('Example workspace',370,235,22,'#626b7a');
      box(370,290,480,180,'#edf0f5');text('ChatGPT',394,334,24);text('Fixture only',394,380,20,'#626b7a');
      box(880,290,480,180,'#edf0f5');text('Gemini',904,334,24);text('Fixture only',904,380,20,'#626b7a');
      box(1520,90,360,620,'#20242d');text('Local model server',1544,136,23,'#f1f3f7');
      text('Synthetic output',1544,192,21,'#aab2c0');
      text('Synthetic desktop fixture — no real desktop data',120,1000,24,'#626b7a');
      box(0,1036,1920,44,'#f0f2f5');
    });
    return {browser,computer};
  })()`, true) as Promise<{ readonly browser: string; readonly computer: string }>;
}
