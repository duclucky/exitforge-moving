export async function api(path, body) {
  let response;
  try{response=await fetch('/api'+path,{...(body!==undefined?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});}
  catch{throw new Error('Could not connect. Your changes are still here; check the connection and retry.');}
  let data;
  try{data=await response.json();}catch{throw new Error('The server returned an incomplete response. Please retry.');}
  if(!response.ok){const error=new Error(data.error||'Something went wrong.');error.status=response.status;throw error;}
  return data;
}
