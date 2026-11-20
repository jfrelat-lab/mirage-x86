"use strict";
return function(M,F,D){
function main(){
var _fp=M.sp-0|0;
  var _t3=0;
  var _t2=0;
  var _t1=0;
  var _t0=0;
  var _v_i=0;
  var _v_s=((0)|0);
  var _v_ic=+((0|0));
  (_v_i=((0)|0));
  for(;(((((_v_i)|0))<(((20000000)|0))?1:0))!==0;(_t0=_v_i,_v_i=((((((_v_i)|0))+(((1)|0))|0))|0),_t0)){
  {
  var _v_pos=+(M.rt.fmod(+(_v_ic),+(47486)));
  (_t1=((+(_v_pos))>=(+(42304))?1:0),_v_s=((((((_v_s)|0))+(((_t1)|0))|0))|0));
  (_t2=3,_v_ic=+(((+(_v_ic))+(+((_t2|0))))));
  }
  }
  M.rt.printf((1048592|0),[_v_s]);
  _t3=((0)|0);
  
  return _t3;
  
  return 0;
}
F["main"]=main;
return function(n,fn){switch(n){
case "main":main=fn;return true;
}
return false;};
};